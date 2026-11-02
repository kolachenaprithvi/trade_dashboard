import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)
BASE = "https://api.upstox.com"
INDEXES = {
    "NIFTY": "NSE_INDEX|Nifty 50",
    "BANKNIFTY": "NSE_INDEX|Nifty Bank",
    "FINNIFTY": "NSE_INDEX|Nifty Fin Service",
    "MIDCPNIFTY": "NSE_INDEX|Nifty Midcap Select",
    "INDIA_VIX": "NSE_INDEX|India VIX",
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

    async def option_chain(self, key: str, expiry: str) -> list[dict[str, Any]]:
        result = await self.get("/v2/option/chain", {"instrument_key": key, "expiry_date": expiry})
        return result if isinstance(result, list) else []

    async def option_contracts(self, key: str) -> list[dict[str, Any]]:
        result = await self.get("/v2/option/contract", {"instrument_key": key})
        return result if isinstance(result, list) else []

    async def ohlc(self, keys: list[str]) -> dict[str, Any]:
        return await self.get("/v3/market-quote/ohlc", {"instrument_key": ",".join(keys), "interval": "1d"})
