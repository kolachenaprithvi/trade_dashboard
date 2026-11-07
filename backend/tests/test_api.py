import asyncio
from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from app.config import settings
from app.main import empty_snapshot, health, require_password, validate_option_symbol
from app.upstox import UpstoxClient


def test_health_does_not_expose_secrets(monkeypatch):
    monkeypatch.setattr(settings, "upstox_access_token", "very-secret-token")
    monkeypatch.setattr(settings, "dashboard_password", "very-secret-password")
    response = health()
    assert response["ok"] is True
    assert "very-secret" not in str(response)


def test_dashboard_password_is_checked_without_disclosing_it(monkeypatch):
    monkeypatch.setattr(settings, "dashboard_password", "correct horse battery")
    with pytest.raises(HTTPException) as result:
        require_password("wrong")
    assert result.value.status_code == 401
    assert "correct horse" not in str(result.value.detail)
    require_password("correct horse battery")


def test_empty_token_returns_explicit_empty_state(monkeypatch):
    monkeypatch.setattr(settings, "upstox_access_token", "")
    response = empty_snapshot()
    assert response["mode"] == "demo"
    assert response["indices"] == {}
    assert response["asOf"] is None


def test_unknown_option_symbol_is_rejected():
    with pytest.raises(HTTPException) as result:
        validate_option_symbol("STOCK")
    assert result.value.status_code == 404


def test_intraday_candles_use_historical_15_minute_data(monkeypatch):
    captured = {}

    async def get(self, path, params):
        captured["path"] = path
        captured["params"] = params
        return {"candles": []}

    monkeypatch.setattr(UpstoxClient, "get", get)

    result = asyncio.run(UpstoxClient("test-access-token").candles("NSE_INDEX|Nifty 50", "intraday"))

    end = date.today()
    start = end - timedelta(days=29)
    assert result == []
    assert captured["path"] == f"/v3/historical-candle/NSE_INDEX|Nifty 50/minutes/15/{end.isoformat()}/{start.isoformat()}"
    assert captured["params"] == {}


def test_legacy_daily_candles_keep_existing_history_window(monkeypatch):
    captured = {}

    async def get(self, path, params):
        captured["path"] = path
        return {"candles": []}

    monkeypatch.setattr(UpstoxClient, "get", get)

    asyncio.run(UpstoxClient("test-access-token").candles("NSE_INDEX|Nifty 50", "daily"))

    end = date.today()
    start = end - timedelta(days=240)
    assert captured["path"] == f"/v3/historical-candle/NSE_INDEX|Nifty 50/days/1/{end.isoformat()}/{start.isoformat()}"


@pytest.mark.parametrize(
    ("timeframe", "unit", "interval"),
    [
        ("1m", "minutes", "1"),
        ("3m", "minutes", "3"),
        ("5m", "minutes", "5"),
        ("10m", "minutes", "10"),
        ("15m", "minutes", "15"),
        ("30m", "minutes", "30"),
        ("1h", "hours", "1"),
        ("2h", "hours", "2"),
        ("3h", "hours", "3"),
        ("4h", "hours", "4"),
        ("1d", "days", "1"),
        ("1w", "weeks", "1"),
        ("1mo", "months", "1"),
    ],
)
def test_candles_use_selected_historical_interval(monkeypatch, timeframe, unit, interval):
    captured = {}

    async def get(self, path, params):
        captured["path"] = path
        return {"candles": []}

    monkeypatch.setattr(UpstoxClient, "get", get)

    result = asyncio.run(UpstoxClient("test-access-token").candles("NSE_INDEX|Nifty 50", timeframe))

    assert result == []
    assert f"/{unit}/{interval}/" in captured["path"]


def test_yearly_candles_aggregate_monthly_history(monkeypatch):
    monthly = [
        ["2024-02-01T00:00:00+05:30", 12, 16, 11, 15, 200, 3],
        ["2023-12-01T00:00:00+05:30", 8, 10, 7, 9, 100, 1],
        ["2024-01-01T00:00:00+05:30", 10, 14, 9, 12, 150, 2],
    ]

    async def get(self, path, params):
        assert "/months/1/" in path
        return {"candles": monthly}

    monkeypatch.setattr(UpstoxClient, "get", get)

    result = asyncio.run(UpstoxClient("test-access-token").candles("NSE_INDEX|Nifty 50", "1y"))

    assert result == [
        ["2023-12-01T00:00:00+05:30", 8, 10, 7, 9, 100, 1],
        ["2024-01-01T00:00:00+05:30", 10, 16, 9, 15, 350, 3],
    ]


def test_upstox_client_sends_bearer_token(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        def json(self):
            return {"status": "success", "data": {}}

    class Client:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, params, headers):
            captured["authorization"] = headers["Authorization"]
            return Response()

    monkeypatch.setattr("app.upstox.httpx.AsyncClient", Client)

    result = asyncio.run(UpstoxClient("test-access-token").get("/test", {}))

    assert result == {}
    assert captured["authorization"] == "Bearer test-access-token"
