import logging
from datetime import date, timedelta
from typing import Any

import httpx

logger = logging.getLogger(__name__)
BASE = "https://api.upstox.com"
INDEXES = {
    "NIFTY": "NSE_INDEX|Nifty 50",
    "BANKNIFTY": "NSE_INDEX|Nifty Bank",
    "INDIA_VIX": "NSE_INDEX|India VIX",
}


BANK_STOCKS = {
    "SBIN": {"label": "SBI", "instrument_key": "NSE_EQ|INE062A01020"},
    "AXISBANK": {"label": "Axis Bank", "instrument_key": "NSE_EQ|INE238A01034"},
    "ICICIBANK": {"label": "ICICI Bank", "instrument_key": "NSE_EQ|INE090A01021"},
    "HDFCBANK": {"label": "HDFC Bank", "instrument_key": "NSE_EQ|INE040A01034"},
    "KOTAKBANK": {"label": "Kotak Mahindra", "instrument_key": "NSE_EQ|INE237A01036"},
}
class UpstoxError(Exception):
    pass


class UpstoxClient:
    def __init__(self, token: str):
        self.token = token

    async def get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{BASE}{path}", params=params, headers=headers)
            if response.status_code >= 400:
                logger.warning("Upstox API returned HTTP %s for %s", response.status_code, path)
                raise UpstoxError(f"Upstox returned HTTP {response.status_code}")
            payload = response.json()
            if payload.get("status") != "success":
                raise UpstoxError("Upstox did not return a successful response")
            return payload.get("data", {})
        except httpx.TimeoutException as exc:
            raise UpstoxError("Upstox request timed out") from exc
        except httpx.HTTPError as exc:
            logger.warning("Upstox network error: %s", type(exc).__name__)
            raise UpstoxError("Upstox is temporarily unreachable") from exc
        except ValueError as exc:
            raise UpstoxError("Upstox returned an invalid response") from exc

    async def quotes(self, keys: list[str]) -> dict[str, Any]:
        return await self.get("/v3/market-quote/quotes", {"instrument_key": ",".join(keys)})

    async def futures_search(self, query: str) -> list[dict[str, Any]]:
        result = await self.get("/v2/instruments/search", {"query": query, "exchanges": "NSE", "segments": "FO", "instrument_types": "FUT", "expiry": "current_month", "page_number": "1", "records": "10"})
        return result if isinstance(result, list) else []
    async def option_chain(self, key: str, expiry: str) -> list[dict[str, Any]]:
        result = await self.get("/v2/option/chain", {"instrument_key": key, "expiry_date": expiry})
        return result if isinstance(result, list) else []

    async def option_contracts(self, key: str) -> list[dict[str, Any]]:
        result = await self.get("/v2/option/contract", {"instrument_key": key})
        return result if isinstance(result, list) else []

    async def ohlc(self, keys: list[str]) -> dict[str, Any]:
        return await self.get("/v3/market-quote/ohlc", {"instrument_key": ",".join(keys), "interval": "1d"})

    async def candles(self, key: str, timeframe: str) -> list[list[Any]]:
        end = date.today()
        history_start = date(2000, 1, 1)
        if timeframe in {"1m", "3m", "5m", "10m", "15m", "intraday"}:
            unit, interval = "minutes", "15" if timeframe == "intraday" else timeframe[:-1]
            start = end - timedelta(days=29)
        elif timeframe == "30m":
            unit, interval = "minutes", "30"
            start = end - timedelta(days=90)
        elif timeframe in {"1h", "2h", "3h", "4h"}:
            unit, interval = "hours", timeframe[:-1]
            start = end - timedelta(days=90)
        elif timeframe == "1d":
            unit, interval = "days", "1"
            start = end - timedelta(days=3650)
        elif timeframe == "daily":
            unit, interval = "days", "1"
            start = end - timedelta(days=240)
        elif timeframe == "1w":
            unit, interval, start = "weeks", "1", history_start
        elif timeframe == "1mo":
            unit, interval, start = "months", "1", history_start
        elif timeframe == "1y":
            unit, interval, start = "months", "1", history_start
        else:
            raise ValueError(f"Unsupported candle timeframe: {timeframe}")

        data = await self.get(
            f"/v3/historical-candle/{key}/{unit}/{interval}/{end.isoformat()}/{start.isoformat()}", {}
        )
        candles = data.get("candles", []) if isinstance(data, dict) else []
        if not isinstance(candles, list):
            return []
        if timeframe != "1y":
            return candles

        annual: dict[int, list[Any]] = {}
        for candle in sorted(candles, key=lambda row: row[0]):
            year = date.fromisoformat(candle[0][:10]).year
            if year not in annual:
                annual[year] = list(candle)
            else:
                current = annual[year]
                current[2] = max(current[2], candle[2])
                current[3] = min(current[3], candle[3])
                current[4] = candle[4]
                current[5] += candle[5]
                if len(current) > 6 and len(candle) > 6:
                    current[6] = candle[6]
        return list(annual.values())
