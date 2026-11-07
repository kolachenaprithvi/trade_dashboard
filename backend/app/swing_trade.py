import asyncio
import gzip
import json
import logging
import math
import time
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import pandas as pd
from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from ta.momentum import RSIIndicator
from ta.trend import ADXIndicator

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
UPSTOX_BASE = "https://api.upstox.com"
INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
TEMPLATE_PATH = Path(__file__).parent / "templates" / "swing_trade_template.xlsx"
REQUEST_INTERVAL_SECONDS = 0.5
RATE_LIMIT_RETRIES = 3
RATE_LIMIT_BACKOFF_SECONDS = 1.0
MAX_RATE_LIMIT_BACKOFF_SECONDS = 30.0
_UPSTOX_COOLDOWN_UNTIL = 0.0
MIN_SPOT_PRICE = 200
MAX_SPOT_PRICE = 5000
MIN_DAILY_VOLUME = 1_000_000

SCANNER_CONFIG = {
    "continuation": {
        "bullish_daily_rsi_min": 55,
        "bearish_daily_rsi_max": 45,
        "hourly_rsi_min": 50,
        "adx_min": 20,
        "relative_volume_min": 1.5,
    },
    "reversal": {
        "daily_rsi_cross": 50,
        "adx_min": 20,
        "relative_volume_min": 1.2,
    },
}

CANDLE_COLUMNS = [
    "timestamp",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "open_interest",
]

EXPORT_HEADERS = [
    "as_of_ist",
    "direction",
    "symbol",
    "setup",
    "score_percent",
    "grade",
    "close",
    "daily_rsi",
    "daily_adx",
    "relative_volume",
    "hourly_close",
    "hourly_rsi",
    "daily_supertrend_direction",
    "hourly_supertrend_7_2_direction",
    "hourly_supertrend_10_3_direction",
    "filter_volume",
    "daily_candle_time",
    "hourly_candle_time",
]


class SwingTradeDataError(Exception):
    """A safe, user-presentable Upstox data or workbook error."""


class UpstoxRateLimitError(SwingTradeDataError):
    """The Upstox historical-data rate limit remained active after retries."""


def _retry_after_seconds(value: str | None, now: datetime | None = None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return max(0.0, seconds) if math.isfinite(seconds) else None
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=IST)
        current_time = now or datetime.now(retry_at.tzinfo)
        if current_time.tzinfo is None:
            current_time = current_time.replace(tzinfo=retry_at.tzinfo)
        return max(0.0, (retry_at - current_time).total_seconds())


class UpstoxRequestGate:
    def __init__(self, interval_seconds: float = REQUEST_INTERVAL_SECONDS):
        self._interval_seconds = interval_seconds
        self._next_request_at = 0.0
        self._semaphore = asyncio.Semaphore(1)
        self._rate_limited = False

    async def get(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
    ) -> httpx.Response:
        global _UPSTOX_COOLDOWN_UNTIL
        async with self._semaphore:
            if self._rate_limited:
                raise UpstoxRateLimitError(
                    "Upstox rate limit persisted after retries. Wait a few minutes, then run the scan again."
                )
            for attempt in range(RATE_LIMIT_RETRIES + 1):
                wait_seconds = max(self._next_request_at, _UPSTOX_COOLDOWN_UNTIL) - time.monotonic()
                if wait_seconds > 0:
                    await asyncio.sleep(wait_seconds)
                self._next_request_at = time.monotonic() + self._interval_seconds
                try:
                    response = await client.get(url, headers=headers)
                except httpx.TimeoutException as exc:
                    raise SwingTradeDataError("Upstox request timed out") from exc
                except httpx.HTTPError as exc:
                    logger.warning("Swing scan network request failed (%s)", type(exc).__name__)
                    raise SwingTradeDataError("Upstox is temporarily unreachable") from exc

                if response.status_code != 429:
                    return response

                fallback_delay = min(
                    RATE_LIMIT_BACKOFF_SECONDS * (2**attempt),
                    MAX_RATE_LIMIT_BACKOFF_SECONDS,
                )
                retry_delay = _retry_after_seconds(response.headers.get("Retry-After"))
                wait_seconds = retry_delay if retry_delay is not None else fallback_delay
                wait_seconds = max(wait_seconds, self._interval_seconds)
                self._next_request_at = max(
                    self._next_request_at,
                    time.monotonic() + wait_seconds,
                )
                _UPSTOX_COOLDOWN_UNTIL = max(
                    _UPSTOX_COOLDOWN_UNTIL,
                    self._next_request_at,
                )
                if attempt == RATE_LIMIT_RETRIES:
                    break

                logger.info(
                    "Upstox rate limit reached for swing scan; retrying in %.1f seconds (%s/%s)",
                    wait_seconds,
                    attempt + 1,
                    RATE_LIMIT_RETRIES,
                )

        self._rate_limited = True
        logger.warning("Upstox rate limit retries exhausted for swing scan")
        raise UpstoxRateLimitError(
            "Upstox rate limit persisted after retries. Wait a few minutes, then run the scan again."
        )


async def _request_json(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    request_gate: UpstoxRequestGate,
) -> dict[str, Any]:
    response = await request_gate.get(client, url, headers)

    if response.status_code >= 400:
        logger.warning("Upstox API returned HTTP %s for swing scan", response.status_code)
        raise SwingTradeDataError(f"Upstox returned HTTP {response.status_code}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise SwingTradeDataError("Upstox returned an invalid response") from exc

    if not isinstance(payload, dict) or payload.get("status") != "success":
        raise SwingTradeDataError("Upstox did not return a successful response")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise SwingTradeDataError("Upstox returned an unexpected data response")
    return data


async def _load_instruments(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    try:
        response = await client.get(INSTRUMENTS_URL, timeout=60)
        response.raise_for_status()
        instruments = json.loads(gzip.decompress(response.content).decode("utf-8"))
    except httpx.TimeoutException as exc:
        raise SwingTradeDataError("Upstox instrument list request timed out") from exc
    except httpx.HTTPError as exc:
        logger.warning("Upstox instrument list request failed (%s)", type(exc).__name__)
        raise SwingTradeDataError("Upstox instrument list is temporarily unavailable") from exc
    except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SwingTradeDataError("Upstox returned an invalid instrument list") from exc

    if not isinstance(instruments, list):
        raise SwingTradeDataError("Upstox returned an unexpected instrument list")
    return [item for item in instruments if isinstance(item, dict)]


def _build_universe(instruments: list[dict[str, Any]]) -> tuple[list[dict[str, str]], int, int]:
    frame = pd.DataFrame(instruments)
    required = {"segment", "exchange", "instrument_type", "trading_symbol", "instrument_key"}
    if not required.issubset(frame.columns):
        raise SwingTradeDataError("Upstox instrument list is missing required fields")

    equities = frame[
        (frame["segment"] == "NSE_EQ")
        & (frame["exchange"] == "NSE")
        & (frame["instrument_type"] == "EQ")
    ].drop_duplicates(subset="trading_symbol")
    futures = frame[
        (frame["segment"] == "NSE_FO")
        & (frame["exchange"] == "NSE")
        & (frame["instrument_type"] == "FUT")
    ].copy()

    futures["underlying_symbol"] = futures["trading_symbol"].astype(str).str.split().str[0]
    underlyings = futures[["underlying_symbol"]].drop_duplicates(subset="underlying_symbol")
    equity_lookup = (
        equities[["trading_symbol", "instrument_key", "name"]]
        .drop_duplicates(subset="trading_symbol")
        .rename(
            columns={
                "trading_symbol": "underlying_symbol",
                "instrument_key": "equity_instrument_key",
                "name": "equity_name",
            }
        )
    )
    matched = underlyings.merge(equity_lookup, on="underlying_symbol", how="inner")
    universe = [
        {
            "symbol": str(row["underlying_symbol"]),
            "instrument_key": str(row["equity_instrument_key"]),
        }
        for row in matched.to_dict("records")
        if row.get("underlying_symbol") and row.get("equity_instrument_key")
    ]
    return universe, len(underlyings), len(matched)


def _candles_frame(candles: list[list[Any]]) -> pd.DataFrame:
    if not candles:
        return pd.DataFrame(columns=CANDLE_COLUMNS)
    frame = pd.DataFrame(candles, columns=CANDLE_COLUMNS)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True).dt.tz_convert(IST)
    numeric_columns = ["open", "high", "low", "close", "volume"]
    frame[numeric_columns] = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    return (
        frame.dropna(subset=numeric_columns)
        .drop_duplicates(subset="timestamp")
        .sort_values("timestamp")
        .reset_index(drop=True)
    )


async def _fetch_candles(
    client: httpx.AsyncClient,
    instrument_key: str,
    unit: str,
    interval: str,
    to_date: date,
    from_date: date,
    headers: dict[str, str],
    request_gate: UpstoxRequestGate,
) -> pd.DataFrame:
    encoded_key = quote(instrument_key, safe="")
    url = (
        f"{UPSTOX_BASE}/v3/historical-candle/{encoded_key}/{unit}/{interval}/"
        f"{to_date.isoformat()}/{from_date.isoformat()}"
    )
    payload = await _request_json(client, url, headers, request_gate)
    candles = payload.get("candles", [])
    if not isinstance(candles, list):
        raise SwingTradeDataError("Upstox returned an unexpected candle response")
    try:
        return _candles_frame(candles)
    except (TypeError, ValueError) as exc:
        raise SwingTradeDataError("Upstox returned invalid candle data") from exc


async def _fetch_hourly_history(
    client: httpx.AsyncClient,
    instrument_key: str,
    as_of: date,
    headers: dict[str, str],
    request_gate: UpstoxRequestGate,
) -> pd.DataFrame:
    cursor = as_of - timedelta(days=180)
    frames: list[pd.DataFrame] = []
    while cursor <= as_of:
        chunk_end = min(cursor + timedelta(days=89), as_of)
        frame = await _fetch_candles(
            client,
            instrument_key,
            "hours",
            "1",
            chunk_end,
            cursor,
            headers,
            request_gate,
        )
        if not frame.empty:
            frames.append(frame)
        cursor = chunk_end + timedelta(days=1)

    if not frames:
        return pd.DataFrame(columns=CANDLE_COLUMNS)
    return (
        pd.concat(frames, ignore_index=True)
        .drop_duplicates(subset="timestamp")
        .sort_values("timestamp")
        .reset_index(drop=True)
    )


def keep_completed_hourly_candles(frame: pd.DataFrame, now: datetime | None = None) -> pd.DataFrame:
    if frame.empty:
        return frame

    current_time = now or datetime.now(IST)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=IST)
    else:
        current_time = current_time.astimezone(IST)

    last_time = pd.Timestamp(frame["timestamp"].iloc[-1])
    if last_time.tzinfo is None:
        last_time = last_time.tz_localize(IST)
    else:
        last_time = last_time.tz_convert(IST)

    if last_time.date() == current_time.date():
        session_close = last_time.normalize() + pd.Timedelta(hours=15, minutes=30)
        candle_end = min(last_time + pd.Timedelta(hours=1), session_close)
        if current_time < candle_end:
            return frame.iloc[:-1].copy().reset_index(drop=True)
    return frame


def calculate_supertrend(
    frame: pd.DataFrame,
    period: int = 7,
    multiplier: float = 2.0,
) -> pd.DataFrame:
    result = frame.copy()
    high = result["high"].astype(float)
    low = result["low"].astype(float)
    close = result["close"].astype(float)
    previous_close = close.shift(1)
    true_range = pd.concat(
        [
            high - low,
            (high - previous_close).abs(),
            (low - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)

    atr = pd.Series(np.nan, index=result.index, dtype=float)
    if len(result) < period:
        result["supertrend"] = np.nan
        result["supertrend_direction"] = 0
        return result

    atr.iloc[period - 1] = true_range.iloc[:period].mean()
    for index in range(period, len(result)):
        atr.iloc[index] = (atr.iloc[index - 1] * (period - 1) + true_range.iloc[index]) / period

    midpoint = (high + low) / 2
    basic_upper = midpoint + multiplier * atr
    basic_lower = midpoint - multiplier * atr
    final_upper = pd.Series(np.nan, index=result.index, dtype=float)
    final_lower = pd.Series(np.nan, index=result.index, dtype=float)
    supertrend = pd.Series(np.nan, index=result.index, dtype=float)
    direction = pd.Series(0, index=result.index, dtype=int)
    first_valid = period - 1
    final_upper.iloc[first_valid] = basic_upper.iloc[first_valid]
    final_lower.iloc[first_valid] = basic_lower.iloc[first_valid]
    direction.iloc[first_valid] = -1
    supertrend.iloc[first_valid] = final_upper.iloc[first_valid]

    for index in range(first_valid + 1, len(result)):
        previous_upper = final_upper.iloc[index - 1]
        previous_lower = final_lower.iloc[index - 1]
        final_upper.iloc[index] = (
            basic_upper.iloc[index]
            if basic_upper.iloc[index] < previous_upper or close.iloc[index - 1] > previous_upper
            else previous_upper
        )
        final_lower.iloc[index] = (
            basic_lower.iloc[index]
            if basic_lower.iloc[index] > previous_lower or close.iloc[index - 1] < previous_lower
            else previous_lower
        )
        if direction.iloc[index - 1] == -1:
            direction.iloc[index] = 1 if close.iloc[index] > final_upper.iloc[index] else -1
        else:
            direction.iloc[index] = -1 if close.iloc[index] < final_lower.iloc[index] else 1
        supertrend.iloc[index] = (
            final_lower.iloc[index] if direction.iloc[index] == 1 else final_upper.iloc[index]
        )

    result["supertrend"] = supertrend
    result["supertrend_direction"] = direction
    return result


def calculate_indicators(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    for period in [50, 100, 200]:
        result[f"ema{period}"] = result["close"].ewm(
            span=period,
            adjust=False,
            min_periods=period,
        ).mean()

    result["rsi14"] = RSIIndicator(close=result["close"], window=14).rsi()
    result["adx14"] = ADXIndicator(
        high=result["high"],
        low=result["low"],
        close=result["close"],
        window=14,
    ).adx()
    result["volume_sma20"] = result["volume"].rolling(20).mean().shift(1)
    result["relative_volume"] = result["volume"] / result["volume_sma20"]
    return calculate_supertrend(result)


def scan_daily_direction(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    required = [
        "close",
        "ema50",
        "ema100",
        "ema200",
        "rsi14",
        "adx14",
        "relative_volume",
        "supertrend",
        "supertrend_direction",
    ]
    if not set(required).issubset(result.columns):
        raise ValueError("Required indicator columns are missing.")

    for flag in [
        "bullish_continuation",
        "bullish_reversal",
        "bearish_continuation",
        "bearish_reversal",
    ]:
        result[flag] = False

    valid = result[required].notna().all(axis=1)
    continuation = SCANNER_CONFIG["continuation"]
    reversal = SCANNER_CONFIG["reversal"]
    result.loc[valid, "bullish_continuation"] = (
        (result.loc[valid, "close"] > result.loc[valid, "ema50"])
        & (result.loc[valid, "close"] > result.loc[valid, "ema100"])
        & (result.loc[valid, "close"] > result.loc[valid, "ema200"])
        & (result.loc[valid, "rsi14"] > continuation["bullish_daily_rsi_min"])
        & (result.loc[valid, "adx14"] > continuation["adx_min"])
        & (result.loc[valid, "relative_volume"] > continuation["relative_volume_min"])
        & (result.loc[valid, "close"] > result.loc[valid, "supertrend"])
        & (result.loc[valid, "supertrend_direction"] == 1)
    )
    result.loc[valid, "bearish_continuation"] = (
        (result.loc[valid, "close"] < result.loc[valid, "ema50"])
        & (result.loc[valid, "close"] < result.loc[valid, "ema100"])
        & (result.loc[valid, "close"] < result.loc[valid, "ema200"])
        & (result.loc[valid, "rsi14"] < continuation["bearish_daily_rsi_max"])
        & (result.loc[valid, "adx14"] > continuation["adx_min"])
        & (result.loc[valid, "relative_volume"] > continuation["relative_volume_min"])
        & (result.loc[valid, "close"] < result.loc[valid, "supertrend"])
        & (result.loc[valid, "supertrend_direction"] == -1)
    )

    previous_close = result["close"].shift(1)
    previous_ema50 = result["ema50"].shift(1)
    previous_ema100 = result["ema100"].shift(1)
    previous_rsi = result["rsi14"].shift(1)
    previous_direction = result["supertrend_direction"].shift(1)
    cross_below_ema = (
        ((previous_close >= previous_ema50) & (result["close"] < result["ema50"]))
        | ((previous_close >= previous_ema100) & (result["close"] < result["ema100"]))
    )
    cross_above_ema = (
        ((previous_close <= previous_ema50) & (result["close"] > result["ema50"]))
        | ((previous_close <= previous_ema100) & (result["close"] > result["ema100"]))
    )
    rsi_cross_below = (
        (previous_rsi >= reversal["daily_rsi_cross"])
        & (result["rsi14"] < reversal["daily_rsi_cross"])
    )
    rsi_cross_above = (
        (previous_rsi <= reversal["daily_rsi_cross"])
        & (result["rsi14"] > reversal["daily_rsi_cross"])
    )
    turns_bearish = (previous_direction == 1) & (result["supertrend_direction"] == -1)
    turns_bullish = (previous_direction == -1) & (result["supertrend_direction"] == 1)
    reversal_valid = (
        valid
        & previous_close.notna()
        & previous_ema50.notna()
        & previous_ema100.notna()
        & previous_rsi.notna()
        & previous_direction.notna()
    )
    result.loc[reversal_valid, "bullish_reversal"] = (
        cross_above_ema
        & rsi_cross_above
        & turns_bullish
        & (result["adx14"] > reversal["adx_min"])
        & (result["relative_volume"] > reversal["relative_volume_min"])
    )
    result.loc[reversal_valid, "bearish_reversal"] = (
        cross_below_ema
        & rsi_cross_below
        & turns_bearish
        & (result["adx14"] > reversal["adx_min"])
        & (result["relative_volume"] > reversal["relative_volume_min"])
    )
    return result


def _score_candidate(result: dict[str, Any]) -> dict[str, Any]:
    direction = result["direction"]
    long_side = direction == "LONG"

    def aligned(long_condition: bool, short_condition: bool) -> bool:
        return long_condition if long_side else short_condition

    score = 0
    score += 10 if aligned(result["close"] > result["daily_ema50"], result["close"] < result["daily_ema50"]) else 0
    score += 5 if aligned(result["daily_ema50"] > result["daily_ema100"], result["daily_ema50"] < result["daily_ema100"]) else 0
    score += 5 if aligned(result["daily_ema100"] > result["daily_ema200"], result["daily_ema100"] < result["daily_ema200"]) else 0
    score += 5 if aligned(result["close"] > result["daily_ema200"], result["close"] < result["daily_ema200"]) else 0
    daily_rsi = result["daily_rsi"]
    score += 10 if aligned(55 <= daily_rsi <= 70, 30 <= daily_rsi <= 45) else 0
    score += 10 if result["daily_adx"] >= 20 else 0
    score += 15 if result["relative_volume"] >= 1.5 else 0
    score += 10 if result["daily_supertrend_direction"] == (1 if long_side else -1) else 0
    score += 5 if result["hourly_supertrend_direction"] == (1 if long_side else -1) else 0
    score += 5 if result["hourly_supertrend_10_3_direction"] == (1 if long_side else -1) else 0
    score += 5 if aligned(result["hourly_ema50"] > result["hourly_ema200"], result["hourly_ema50"] < result["hourly_ema200"]) else 0
    score += 5 if aligned(result["hourly_rsi"] > 50, result["hourly_rsi"] < 50) else 0

    score_percent = round(score / 90 * 100, 1)
    if score_percent >= 80:
        grade = "A - Strong alignment"
    elif score_percent >= 65:
        grade = "B - Watchlist"
    elif score_percent >= 50:
        grade = "C - Weak alignment"
    else:
        grade = "Reject"
    return {**result, "score": score, "score_percent": score_percent, "grade": grade}


async def _scan_stock(
    client: httpx.AsyncClient,
    stock: dict[str, str],
    as_of: date,
    headers: dict[str, str],
    request_gate: UpstoxRequestGate,
) -> dict[str, Any]:
    symbol = stock["symbol"]
    result_base: dict[str, Any] = {"symbol": symbol, "eligible": False}
    try:
        daily = await _fetch_candles(
            client,
            stock["instrument_key"],
            "days",
            "1",
            as_of,
            as_of - timedelta(days=540),
            headers,
            request_gate,
        )
        if daily.empty:
            return {
                **result_base,
                "eligible": False,
                "status": "NO_DAILY_DATA",
                "error": "No daily candles returned",
            }

        latest = daily.iloc[-1]
        spot_price = float(latest["close"])
        daily_volume = int(latest["volume"])
        result_base = {
            "symbol": symbol,
            "filter_price": spot_price,
            "filter_volume": daily_volume,
            "eligible": MIN_SPOT_PRICE <= spot_price <= MAX_SPOT_PRICE and daily_volume >= MIN_DAILY_VOLUME,
        }
        if not result_base["eligible"]:
            return {**result_base, "status": "FILTERED_OUT"}
        if len(daily) < 220:
            return {
                **result_base,
                "status": "INSUFFICIENT_DAILY_DATA",
                "error": "Fewer than 220 daily candles returned",
            }

        hourly = keep_completed_hourly_candles(
            await _fetch_hourly_history(client, stock["instrument_key"], as_of, headers, request_gate)
        )
        if hourly.empty or len(hourly) < 220:
            return {
                **result_base,
                "status": "INSUFFICIENT_HOURLY_DATA",
                "error": "Fewer than 220 completed hourly candles returned",
            }

        daily_indicators = scan_daily_direction(calculate_indicators(daily))
        hourly_indicators = calculate_indicators(hourly)
        hourly_10_3 = calculate_supertrend(hourly_indicators, period=10, multiplier=3.0)
        hourly_indicators["supertrend_7_2"] = hourly_indicators["supertrend"]
        hourly_indicators["supertrend_direction_7_2"] = hourly_indicators["supertrend_direction"]
        hourly_indicators["supertrend_10_3"] = hourly_10_3["supertrend"]
        hourly_indicators["supertrend_direction_10_3"] = hourly_10_3["supertrend_direction"]
        daily_last = daily_indicators.iloc[-1]
        hourly_last = hourly_indicators.iloc[-1]

        required_daily = [
            "close",
            "ema50",
            "ema100",
            "ema200",
            "rsi14",
            "adx14",
            "relative_volume",
            "supertrend",
            "supertrend_direction",
        ]
        required_hourly = [
            "close",
            "ema50",
            "ema200",
            "rsi14",
            "adx14",
            "supertrend_7_2",
            "supertrend_direction_7_2",
            "supertrend_10_3",
            "supertrend_direction_10_3",
        ]
        if daily_last[required_daily].isna().any():
            return {
                **result_base,
                "status": "INVALID_DAILY_INDICATORS",
                "error": "Daily indicator values are incomplete",
            }
        if hourly_last[required_hourly].isna().any():
            return {
                **result_base,
                "status": "INVALID_HOURLY_INDICATORS",
                "error": "Hourly indicator values are incomplete",
            }

        hourly_long = (
            hourly_last["close"] > hourly_last["ema50"]
            and hourly_last["close"] > hourly_last["ema200"]
            and hourly_last["rsi14"] > 50
            and hourly_last["supertrend_direction_7_2"] == 1
            and hourly_last["supertrend_direction_10_3"] == 1
            and hourly_last["close"] > hourly_last["supertrend_7_2"]
            and hourly_last["close"] > hourly_last["supertrend_10_3"]
        )
        hourly_short = (
            hourly_last["close"] < hourly_last["ema50"]
            and hourly_last["close"] < hourly_last["ema200"]
            and hourly_last["rsi14"] < 50
            and hourly_last["supertrend_direction_7_2"] == -1
            and hourly_last["supertrend_direction_10_3"] == -1
            and hourly_last["close"] < hourly_last["supertrend_7_2"]
            and hourly_last["close"] < hourly_last["supertrend_10_3"]
        )
        long_continuation = bool(daily_last["bullish_continuation"]) and hourly_long
        long_reversal = bool(daily_last["bullish_reversal"]) and hourly_long
        short_continuation = bool(daily_last["bearish_continuation"]) and hourly_short
        short_reversal = bool(daily_last["bearish_reversal"]) and hourly_short

        if long_continuation:
            direction, setup = "LONG", "BULLISH_CONTINUATION"
        elif long_reversal:
            direction, setup = "LONG", "BULLISH_REVERSAL"
        elif short_continuation:
            direction, setup = "SHORT", "BEARISH_CONTINUATION"
        elif short_reversal:
            direction, setup = "SHORT", "BEARISH_REVERSAL"
        else:
            direction, setup = "NONE", "NO_SETUP"

        result = {
            **result_base,
            "status": "OK",
            "direction": direction,
            "setup": setup,
            "close": round(float(daily_last["close"]), 2),
            "daily_ema50": round(float(daily_last["ema50"]), 2),
            "daily_ema100": round(float(daily_last["ema100"]), 2),
            "daily_ema200": round(float(daily_last["ema200"]), 2),
            "daily_rsi": round(float(daily_last["rsi14"]), 2),
            "daily_adx": round(float(daily_last["adx14"]), 2),
            "relative_volume": round(float(daily_last["relative_volume"]), 2),
            "hourly_close": round(float(hourly_last["close"]), 2),
            "hourly_ema50": round(float(hourly_last["ema50"]), 2),
            "hourly_ema200": round(float(hourly_last["ema200"]), 2),
            "hourly_rsi": round(float(hourly_last["rsi14"]), 2),
            "hourly_adx": round(float(hourly_last["adx14"]), 2),
            "daily_supertrend_direction": int(daily_last["supertrend_direction"]),
            "hourly_supertrend_direction": int(hourly_last["supertrend_direction_7_2"]),
            "hourly_supertrend_10_3_direction": int(hourly_last["supertrend_direction_10_3"]),
            "daily_candle_time": str(daily_last["timestamp"]),
            "hourly_candle_time": str(hourly_last["timestamp"]),
        }
        return _score_candidate(result) if direction != "NONE" else result
    except UpstoxRateLimitError as exc:
        return {
            **result_base,
            "status": "RATE_LIMITED",
            "error": str(exc),
        }
    except Exception as exc:
        logger.warning("Swing scan failed for %s (%s)", symbol, type(exc).__name__)
        return {
            **result_base,
            "status": "ERROR",
            "error": str(exc)[:250] or type(exc).__name__,
        }


async def run_swing_trade_scan(token: str) -> dict[str, Any]:
    if not token:
        raise SwingTradeDataError("Configure the server-side Upstox access token to run a swing scan.")

    as_of_time = datetime.now(IST)
    as_of = as_of_time.date()
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    request_gate = UpstoxRequestGate()
    limits = httpx.Limits(max_connections=1, max_keepalive_connections=1)
    timeout = httpx.Timeout(30.0)

    try:
        async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
            instruments = await _load_instruments(client)
            universe, underlying_count, matched_count = _build_universe(instruments)
            scan_results = await asyncio.gather(
                *(
                _scan_stock(client, stock, as_of, headers, request_gate)
                    for stock in universe
                )
            )
    except SwingTradeDataError:
        raise
    except Exception as exc:
        logger.exception("Swing scan could not be completed")
        raise SwingTradeDataError("The swing scan could not be completed. Check the backend logs.") from exc

    eligible_count = sum(bool(result.get("eligible")) for result in scan_results)
    successful = [result for result in scan_results if result.get("status") == "OK"]
    candidates = [
        result
        for result in successful
        if result.get("direction") in {"LONG", "SHORT"}
        and result.get("setup") in {
            "BULLISH_CONTINUATION",
            "BULLISH_REVERSAL",
            "BEARISH_CONTINUATION",
            "BEARISH_REVERSAL",
        }
    ]
    priorities = {
        "BULLISH_CONTINUATION": 1,
        "BEARISH_CONTINUATION": 1,
        "BULLISH_REVERSAL": 2,
        "BEARISH_REVERSAL": 2,
    }
    candidates.sort(
        key=lambda item: (
            item["direction"],
            priorities[item["setup"]],
            -item["score"],
            -item["relative_volume"],
        )
    )
    issues = [
        {
            "symbol": result.get("symbol", ""),
            "issue": result.get("error", result.get("status", "Unknown scan issue")),
        }
        for result in scan_results
        if result.get("status") not in {"OK", "FILTERED_OUT"}
    ]
    if any(result.get("status") == "RATE_LIMITED" for result in scan_results):
        raise UpstoxRateLimitError(
            "Upstox rate limit persisted after retries. Wait a few minutes, then run the scan again."
        )

    return {
        "asOf": as_of_time.isoformat(),
        "metrics": {
            "foUnderlyingCount": underlying_count,
            "matchedCount": matched_count,
            "eligibleCount": eligible_count,
            "scannedCount": len(successful),
            "candidateCount": len(candidates),
            "longCount": sum(item["direction"] == "LONG" for item in candidates),
            "shortCount": sum(item["direction"] == "SHORT" for item in candidates),
            "issueCount": len(issues),
        },
        "rows": candidates,
        "issues": issues,
    }


def build_swing_trade_workbook(scan: dict[str, Any]) -> tuple[str, bytes]:
    if not TEMPLATE_PATH.is_file():
        raise SwingTradeDataError("The swing-trade workbook template is missing from the backend.")
    try:
        workbook = load_workbook(TEMPLATE_PATH)
    except (OSError, ValueError) as exc:
        raise SwingTradeDataError("The swing-trade workbook template could not be opened.") from exc

    for sheet_name in ["Top Spread per Stock", "Ranked Spreads"]:
        if sheet_name not in workbook.sheetnames:
            raise SwingTradeDataError(f"The workbook template is missing the {sheet_name} sheet.")
        sheet = workbook[sheet_name]
        for row in sheet.iter_rows(min_row=2, max_row=sheet.max_row):
            for cell in row:
                cell.value = None
        sheet.auto_filter.ref = f"A1:{get_column_letter(sheet.max_column)}1"

    if "MANKIND Payoff" not in workbook.sheetnames or "Method and Limits" not in workbook.sheetnames:
        raise SwingTradeDataError("The workbook template is missing required method or payoff sheets.")
    payoff = workbook["MANKIND Payoff"]
    for merged_range in list(payoff.merged_cells.ranges):
        payoff.unmerge_cells(str(merged_range))
    for row in payoff.iter_rows():
        for cell in row:
            cell.value = None
    payoff["A1"] = "No option spread generated by this stock-direction scanner"
    payoff["A2"] = "This scanner does not fetch option-chain quotes or calculate option spread legs."
    payoff.merge_cells("A1:C1")
    payoff.merge_cells("A2:C2")

    method = workbook["Method and Limits"]
    notes = {
        "Purpose": "Daily/hourly bullish and bearish stock-direction scan for NSE F&O underlyings.",
        "Candidate filter": "NSE F&O underlyings matched to NSE equities, priced ₹200–₹5,000, with at least 1,000,000 daily volume.",
        "Export scope": "Directional Scan contains LONG and SHORT stock candidates. Spread tabs are blank because this scanner does not calculate option quotes or legs.",
        "Hourly Supertrend confirmation": "Both 7,2 and 10,3 must agree on the latest completed hourly candle. The active hourly candle is ignored until it closes (the final 15:15 bar completes at the 15:30 market close).",
    }
    for label, note in notes.items():
        row_number = next(
            (
                row[0].row
                for row in method.iter_rows(min_col=1, max_col=1)
                if row[0].value == label
            ),
            None,
        )
        if row_number is None:
            row_number = method.max_row + 1
            method.cell(row_number, 1, label)
        method.cell(row_number, 2, note)
    method["B12"] = "Directional score ranks indicator alignment; it is not a probability or guarantee of return."
    for row in method.iter_rows(min_row=1, max_row=method.max_row):
        if row[0].value in {"Export scope", "Hourly Supertrend confirmation"}:
            row[1].alignment = Alignment(wrap_text=True, vertical="top")

    issues_sheet = workbook["Data Issues"] if "Data Issues" in workbook.sheetnames else workbook.create_sheet("Data Issues")
    for row in issues_sheet.iter_rows(min_row=2, max_row=issues_sheet.max_row):
        for cell in row:
            cell.value = None
    issues = scan.get("issues", [])
    if not issues:
        issues_sheet.cell(2, 1, "-")
        issues_sheet.cell(2, 2, "No scanner/API processing errors recorded. This does not independently validate market data.")
    else:
        for row_number, issue in enumerate(issues, start=2):
            for column_number, value in enumerate(
                [issue.get("symbol", ""), issue.get("issue", "Unknown scan issue")],
                start=1,
            ):
                cell = issues_sheet.cell(row_number, column_number, value)
                if isinstance(value, str):
                    cell.data_type = "s"

    if "Directional Scan" in workbook.sheetnames:
        del workbook["Directional Scan"]
    sheet = workbook.create_sheet("Directional Scan", 0)
    sheet.append(EXPORT_HEADERS)
    for candidate in scan.get("rows", []):
        sheet.append(
            [
                scan["asOf"][:10],
                candidate.get("direction"),
                candidate.get("symbol"),
                candidate.get("setup"),
                candidate.get("score_percent"),
                candidate.get("grade"),
                candidate.get("close"),
                candidate.get("daily_rsi"),
                candidate.get("daily_adx"),
                candidate.get("relative_volume"),
                candidate.get("hourly_close"),
                candidate.get("hourly_rsi"),
                candidate.get("daily_supertrend_direction"),
                candidate.get("hourly_supertrend_direction"),
                candidate.get("hourly_supertrend_10_3_direction"),
                candidate.get("filter_volume"),
                candidate.get("daily_candle_time"),
                candidate.get("hourly_candle_time"),
            ]
        )
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"

    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(EXPORT_HEADERS))}{max(1, sheet.max_row)}"
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F4E78")
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    for row_number in range(2, sheet.max_row + 1):
        fill_color = "E2F0D9" if sheet.cell(row_number, 2).value == "LONG" else "FCE4D6"
        for cell in sheet[row_number]:
            cell.fill = PatternFill("solid", fgColor=fill_color)
    for column_number, header in enumerate(EXPORT_HEADERS, start=1):
        sheet.column_dimensions[get_column_letter(column_number)].width = min(max(len(header) + 2, 14), 24)

    output = BytesIO()
    try:
        workbook.save(output)
    except (OSError, ValueError) as exc:
        raise SwingTradeDataError("The swing-trade workbook could not be generated.") from exc
    filename = f"NSE_FO_Swing_Trade_Scan_{scan['asOf'][:10].replace('-', '')}.xlsx"
    return filename, output.getvalue()
