import asyncio
from datetime import datetime, timedelta
from io import BytesIO

import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.config import settings
from app.main import app, swing_trade_export, swing_trade_scan
from app.swing_trade import (
    EXPORT_HEADERS,
    RATE_LIMIT_RETRIES,
    _build_universe,
    _retry_after_seconds,
    _request_json,
    _score_candidate,
    _fetch_hourly_history,
    TEMPLATE_PATH,
    UpstoxRequestGate,
    SwingTradeDataError,
    build_swing_trade_workbook,
    keep_completed_hourly_candles,
    scan_daily_direction,
    run_swing_trade_scan,
)


def test_build_universe_matches_distinct_futures_to_equities():
    instruments = [
        {
            "segment": "NSE_FO",
            "exchange": "NSE",
            "instrument_type": "FUT",
            "trading_symbol": "ABC 30 NOV FUT",
            "instrument_key": "future-1",
        },
        {
            "segment": "NSE_FO",
            "exchange": "NSE",
            "instrument_type": "FUT",
            "trading_symbol": "ABC 28 DEC FUT",
            "instrument_key": "future-2",
        },
        {
            "segment": "NSE_EQ",
            "exchange": "NSE",
            "instrument_type": "EQ",
            "trading_symbol": "ABC",
            "instrument_key": "equity-abc",
            "name": "ABC Limited",
        },
    ]

    universe, underlying_count, matched_count = _build_universe(instruments)

    assert universe == [{"symbol": "ABC", "instrument_key": "equity-abc"}]
    assert underlying_count == 1
    assert matched_count == 1


def test_retry_after_parses_seconds_and_http_dates():
    now = datetime.fromisoformat("2026-11-07T10:00:00+00:00")

    assert _retry_after_seconds("3", now) == 3
    assert _retry_after_seconds("Sat, 07 Nov 2026 10:00:05 GMT", now) == 5
    assert _retry_after_seconds("invalid", now) is None


def test_upstox_request_gate_retries_429_using_retry_after(monkeypatch):
    monkeypatch.setattr("app.swing_trade._UPSTOX_COOLDOWN_UNTIL", 0.0)

    class Response:
        def __init__(self, status_code, headers):
            self.status_code = status_code
            self.headers = headers

        def json(self):
            return {"status": "success", "data": {"candles": []}}

    class Client:
        def __init__(self):
            self.responses = [
                Response(429, {"Retry-After": "2"}),
                Response(200, {}),
            ]
            self.calls = 0

        async def get(self, url, headers):
            assert url == "https://upstox.test/candles"
            assert headers == {}
            self.calls += 1
            return self.responses.pop(0)

    delays = []

    async def record_sleep(delay):
        assert delay > 0
        delays.append(delay)

    monkeypatch.setattr("app.swing_trade.asyncio.sleep", record_sleep)
    client = Client()

    payload = asyncio.run(_request_json(client, "https://upstox.test/candles", {}, UpstoxRequestGate(0)))

    assert payload == {"candles": []}
    assert client.calls == 2
    assert delays == [pytest.approx(2, abs=0.01)]


def test_upstox_request_gate_stops_after_bounded_429_retries(monkeypatch):
    monkeypatch.setattr("app.swing_trade._UPSTOX_COOLDOWN_UNTIL", 0.0)

    class Response:
        status_code = 429
        headers = {}

    class Client:
        def __init__(self):
            self.calls = 0

        async def get(self, url, headers):
            assert url == "https://upstox.test/candles"
            assert headers == {}
            self.calls += 1
            return Response()

    async def skip_sleep(delay):
        assert delay > 0
        pass

    monkeypatch.setattr("app.swing_trade.asyncio.sleep", skip_sleep)
    client = Client()

    with pytest.raises(SwingTradeDataError, match="rate limit persisted"):
        asyncio.run(_request_json(client, "https://upstox.test/candles", {}, UpstoxRequestGate(0)))

    assert client.calls == RATE_LIMIT_RETRIES + 1


def test_upstox_request_gate_paces_successful_requests(monkeypatch):
    monkeypatch.setattr("app.swing_trade._UPSTOX_COOLDOWN_UNTIL", 0.0)

    class Response:
        status_code = 200
        headers = {}

        def json(self):
            return {"status": "success", "data": {"candles": []}}

    class Client:
        def __init__(self):
            self.calls = 0

        async def get(self, url, headers):
            assert url == "https://upstox.test/candles"
            assert headers == {}
            self.calls += 1
            return Response()

    delays = []

    async def record_sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("app.swing_trade.asyncio.sleep", record_sleep)
    client = Client()
    request_gate = UpstoxRequestGate(0.5)

    async def make_requests():
        await _request_json(client, "https://upstox.test/candles", {}, request_gate)
        await _request_json(client, "https://upstox.test/candles", {}, request_gate)

    asyncio.run(make_requests())

    assert client.calls == 2
    assert len(delays) == 1
    assert delays[0] == pytest.approx(0.5, abs=0.01)


def test_hourly_history_uses_quarter_sized_non_overlapping_chunks(monkeypatch):
    requests = []

    async def fake_fetch_candles(
        client,
        instrument_key,
        unit,
        interval,
        to_date,
        from_date,
        headers,
        request_gate,
    ):
        assert client is None
        assert instrument_key == "NSE_EQ|TEST"
        assert unit == "hours"
        assert interval == "1"
        assert headers == {}
        assert isinstance(request_gate, UpstoxRequestGate)
        requests.append((from_date, to_date))
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])

    monkeypatch.setattr("app.swing_trade._fetch_candles", fake_fetch_candles)

    result = asyncio.run(
        _fetch_hourly_history(
            None,
            "NSE_EQ|TEST",
            datetime.fromisoformat("2026-11-07T12:00:00+05:30").date(),
            {},
            UpstoxRequestGate(0),
        )
    )

    assert result.empty
    assert len(requests) == 3
    assert all((to_date - from_date).days <= 89 for from_date, to_date in requests)
    assert all(
        requests[index][0] == requests[index - 1][1] + timedelta(days=1)
        for index in range(1, len(requests))
    )


def test_daily_direction_finds_bullish_continuation():
    frame = pd.DataFrame(
        [
            {
                "close": 120,
                "ema50": 110,
                "ema100": 105,
                "ema200": 100,
                "rsi14": 60,
                "adx14": 25,
                "relative_volume": 2,
                "supertrend": 108,
                "supertrend_direction": 1,
            }
        ]
    )

    result = scan_daily_direction(frame)

    assert bool(result.loc[0, "bullish_continuation"])
    assert not bool(result.loc[0, "bearish_continuation"])
    assert not bool(result.loc[0, "bullish_reversal"])


def test_directional_score_matches_notebook_scale_and_requires_strict_alignment():
    aligned_long = _score_candidate(
        {
            "direction": "LONG",
            "close": 120,
            "daily_ema50": 110,
            "daily_ema100": 105,
            "daily_ema200": 100,
            "daily_rsi": 60,
            "daily_adx": 25,
            "relative_volume": 2,
            "daily_supertrend_direction": 1,
            "hourly_supertrend_direction": 1,
            "hourly_supertrend_10_3_direction": 1,
            "hourly_ema50": 110,
            "hourly_ema200": 100,
            "hourly_rsi": 60,
        }
    )
    tied_short = _score_candidate(
        {
            "direction": "SHORT",
            "close": 100,
            "daily_ema50": 100,
            "daily_ema100": 100,
            "daily_ema200": 100,
            "daily_rsi": 50,
            "daily_adx": 19,
            "relative_volume": 1,
            "daily_supertrend_direction": 1,
            "hourly_supertrend_direction": 1,
            "hourly_supertrend_10_3_direction": 1,
            "hourly_ema50": 100,
            "hourly_ema200": 100,
            "hourly_rsi": 50,
        }
    )

    assert aligned_long["score"] == 90
    assert aligned_long["score_percent"] == 100
    assert aligned_long["grade"] == "A - Strong alignment"
    assert tied_short["score"] == 0


def test_incomplete_hourly_bar_is_excluded_before_market_close():
    frame = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(
                [
                    "2026-11-06T14:15:00+05:30",
                    "2026-11-06T15:15:00+05:30",
                ],
                utc=True,
            ).tz_convert("Asia/Kolkata")
        }
    )

    result = keep_completed_hourly_candles(frame, datetime.fromisoformat("2026-11-06T15:20:00+05:30"))

    assert len(result) == 1
    assert result.iloc[-1]["timestamp"].hour == 14


def test_workbook_export_populates_directional_sheet_and_clears_spread_examples():
    candidate = {
        "direction": "LONG",
        "symbol": "ABC",
        "setup": "BULLISH_CONTINUATION",
        "score_percent": 100,
        "grade": "A - Strong alignment",
        "close": 120,
        "daily_rsi": 60,
        "daily_adx": 25,
        "relative_volume": 2,
        "hourly_close": 120,
        "hourly_rsi": 60,
        "daily_supertrend_direction": 1,
        "hourly_supertrend_direction": 1,
        "hourly_supertrend_10_3_direction": 1,
        "filter_volume": 1_500_000,
        "daily_candle_time": "2026-11-06T00:00:00+05:30",
        "hourly_candle_time": "2026-11-06T15:15:00+05:30",
    }
    filename, content = build_swing_trade_workbook(
        {
            "asOf": "2026-11-07T12:00:00+05:30",
            "rows": [candidate],
            "issues": [],
        }
    )

    workbook = load_workbook(BytesIO(content), data_only=True)
    sheet = workbook["Directional Scan"]
    assert filename == "NSE_FO_Swing_Trade_Scan_20261107.xlsx"
    assert [sheet.cell(1, column).value for column in range(1, 19)] == EXPORT_HEADERS
    assert sheet.max_row == 2
    assert sheet["B2"].value == "LONG"
    assert sheet["C2"].value == "ABC"
    assert workbook["Top Spread per Stock"]["A2"].value is None
    assert workbook["Ranked Spreads"]["A2"].value is None
    assert workbook["MANKIND Payoff"]["A1"].value == "No option spread generated by this stock-direction scanner"
    assert len(workbook["MANKIND Payoff"]._charts) == 1
    assert workbook["Data Issues"]["A2"].value == "-"


def test_packaged_workbook_template_contains_no_stale_scan_results():
    workbook = load_workbook(TEMPLATE_PATH, data_only=True)
    sheet = workbook["Directional Scan"]

    assert sheet.max_row == 1
    assert sheet.max_column == len(EXPORT_HEADERS)
    assert not any(
        cell.value is not None
        for sheet_name in ["Top Spread per Stock", "Ranked Spreads"]
        for row in workbook[sheet_name].iter_rows(min_row=2)
        for cell in row
    )


def test_swing_trade_scan_requires_password(monkeypatch):
    monkeypatch.setattr(settings, "dashboard_password", "private-password")

    with pytest.raises(HTTPException) as result:
        asyncio.run(swing_trade_scan("wrong-password"))

    assert result.value.status_code == 401


def test_swing_trade_scan_allows_browser_post_preflight():
    response = TestClient(app).options(
        "/api/swing-trade/scan",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-dashboard-password",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-methods"]


def test_swing_trade_scan_without_token_reports_configuration_error(monkeypatch):
    monkeypatch.setattr(settings, "dashboard_password", "private-password")
    monkeypatch.setattr(settings, "upstox_access_token", "")

    with pytest.raises(HTTPException) as result:
        asyncio.run(swing_trade_scan("private-password"))

    assert result.value.status_code == 503


def test_swing_trade_scan_prepares_authenticated_workbook_download(monkeypatch):
    monkeypatch.setattr(settings, "dashboard_password", "private-password")
    monkeypatch.setattr(settings, "upstox_access_token", "configured-token")

    async def fake_scan(token):
        assert token == "configured-token"
        return {
            "asOf": "2026-11-07T12:00:00+05:30",
            "metrics": {
                "foUnderlyingCount": 1,
                "matchedCount": 1,
                "eligibleCount": 0,
                "scannedCount": 0,
                "candidateCount": 0,
                "longCount": 0,
                "shortCount": 0,
                "issueCount": 0,
            },
            "rows": [],
            "issues": [],
        }

    monkeypatch.setattr("app.main.run_swing_trade_scan", fake_scan)

    result = asyncio.run(swing_trade_scan("private-password"))
    response = swing_trade_export(result["scanId"], "private-password")

    assert result["fileName"] == "NSE_FO_Swing_Trade_Scan_20261107.xlsx"
    assert response.status_code == 200
    assert response.media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert response.body[:2] == b"PK"


def test_swing_trade_scan_runs_both_timeframes_and_returns_directional_candidates(monkeypatch):
    daily_end = pd.Timestamp.now(tz="Asia/Kolkata").normalize() - pd.Timedelta(days=1)
    hourly_end = daily_end + pd.Timedelta(hours=14, minutes=15)

    def rising_frame(count, frequency, end, step):
        closes = [400 + index * step for index in range(count)]
        volumes = [1_500_000] * count
        volumes[-1] = 3_000_000
        return pd.DataFrame(
            {
                "timestamp": pd.date_range(end=end, periods=count, freq=frequency),
                "open": [close - 0.2 for close in closes],
                "high": [close + 1 for close in closes],
                "low": [close - 1 for close in closes],
                "close": closes,
                "volume": volumes,
            }
        )

    daily = rising_frame(240, "D", daily_end, 0.25)
    hourly = rising_frame(240, "h", hourly_end, 0.1)
    instruments = [
        {
            "segment": "NSE_FO",
            "exchange": "NSE",
            "instrument_type": "FUT",
            "trading_symbol": "ABC 30 NOV FUT",
            "instrument_key": "future-1",
        },
        {
            "segment": "NSE_EQ",
            "exchange": "NSE",
            "instrument_type": "EQ",
            "trading_symbol": "ABC",
            "instrument_key": "equity-abc",
            "name": "ABC Limited",
        },
    ]

    async def fake_load_instruments(client):
        assert client is not None
        return instruments

    async def fake_fetch_candles(
        client,
        instrument_key,
        unit,
        interval,
        to_date,
        from_date,
        headers,
        request_gate,
    ):
        assert client is not None
        assert instrument_key == "equity-abc"
        assert unit == "days"
        assert interval == "1"
        assert to_date >= from_date
        assert headers["Authorization"].startswith("Bearer ")
        assert isinstance(request_gate, UpstoxRequestGate)
        return daily

    async def fake_fetch_hourly(client, instrument_key, as_of, headers, request_gate):
        assert client is not None
        assert instrument_key == "equity-abc"
        assert as_of is not None
        assert headers["Authorization"].startswith("Bearer ")
        assert isinstance(request_gate, UpstoxRequestGate)
        return hourly

    monkeypatch.setattr("app.swing_trade._load_instruments", fake_load_instruments)
    monkeypatch.setattr("app.swing_trade._fetch_candles", fake_fetch_candles)
    monkeypatch.setattr("app.swing_trade._fetch_hourly_history", fake_fetch_hourly)

    result = asyncio.run(run_swing_trade_scan("configured-token"))

    assert result["metrics"]["eligibleCount"] == 1
    assert result["metrics"]["scannedCount"] == 1
    assert result["metrics"]["candidateCount"] == 1
    assert result["rows"][0]["symbol"] == "ABC"
    assert result["rows"][0]["direction"] == "LONG"

    async def failed_fetch_hourly(client, instrument_key, as_of, headers, request_gate):
        assert client is not None
        assert instrument_key == "equity-abc"
        assert as_of is not None
        assert headers["Authorization"].startswith("Bearer ")
        assert isinstance(request_gate, UpstoxRequestGate)
        raise RuntimeError("hourly endpoint failed")

    monkeypatch.setattr("app.swing_trade._fetch_hourly_history", failed_fetch_hourly)
    failed_result = asyncio.run(run_swing_trade_scan("configured-token"))

    assert failed_result["metrics"]["eligibleCount"] == 1
    assert failed_result["metrics"]["scannedCount"] == 0
    assert failed_result["metrics"]["issueCount"] == 1
