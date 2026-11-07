import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .upstox import BANK_STOCKS, INDEXES, UpstoxClient, UpstoxError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("tradely")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_password(supplied: str | None) -> None:
    if not settings.dashboard_password:
        raise HTTPException(status_code=503, detail="Dashboard password is not configured")
    if not supplied or not secrets.compare_digest(supplied, settings.dashboard_password):
        raise HTTPException(status_code=401, detail="Access denied")


def empty_snapshot() -> dict:
    return {"mode": "demo", "status": "token_missing", "asOf": None, "indices": {}, "bankStocks": {}, "technicals": {}, "message": "Add a server-side Upstox access token to enable market data."}


def validate_option_symbol(symbol: str) -> str:
    normalized = symbol.upper()
    if normalized not in INDEXES or normalized == "INDIA_VIX":
        raise HTTPException(status_code=404, detail="Unknown F&O index")
    return normalized


async def snapshot() -> dict:
    if not settings.upstox_access_token:
        return empty_snapshot()
    try:
        api = UpstoxClient(settings.upstox_access_token)
        all_keys = [*INDEXES.values(), *(stock["instrument_key"] for stock in BANK_STOCKS.values())]
        data = await api.quotes(all_keys)
        try:
            technical_data = await api.ohlc(list(INDEXES.values()))
        except UpstoxError:
            # Keep valid quote snapshots even if the optional OHLC endpoint is unavailable.
            technical_data = {}

        def quote_for(key: str):
            item = next((v for v in data.values() if v.get("instrument_token") == key), None)
            if not item:
                return None
            return {"instrumentKey": item.get("instrument_token", key), "lastPrice": item.get("last_price"), "change": item.get("net_change"), "volume": item.get("volume"), "oi": item.get("oi"), "timestamp": item.get("timestamp"), "ohlc": item.get("ohlc")}

        quotes = {}
        for symbol, key in INDEXES.items():
            quote = quote_for(key)
            if quote:
                quotes[symbol] = quote
        banks = {}
        for symbol, stock in BANK_STOCKS.items():
            quote = quote_for(stock["instrument_key"])
            if quote:
                banks[symbol] = {**quote, "label": stock["label"]}
        return {"mode": "snapshot", "status": "connected", "asOf": now_iso(), "indices": quotes, "bankStocks": banks, "technicals": technical_data, "message": None}
    except UpstoxError as exc:
        return {"mode": "unavailable", "status": "upstream_error", "asOf": now_iso(), "indices": {}, "bankStocks": {}, "technicals": {}, "message": str(exc)}


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not settings.dashboard_password:
        logger.warning("DASHBOARD_PASSWORD is not configured; protected routes are unavailable")
    yield


app = FastAPI(title="Tradely Index Terminal API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_credentials=False, allow_methods=["GET"], allow_headers=["X-Dashboard-Password", "Content-Type"])


@app.get("/api/health")
def health():
    return {"ok": True, "serverTime": now_iso()}


@app.get("/api/dashboard")
async def dashboard(x_dashboard_password: str | None = Header(default=None)):
    require_password(x_dashboard_password)
    return await snapshot()


@app.get("/api/futures")
async def futures(x_dashboard_password: str | None = Header(default=None)):
    require_password(x_dashboard_password)
    if not settings.upstox_access_token:
        return {"mode": "demo", "status": "token_missing", "rows": [], "message": "Configure the server-side Upstox access token."}
    try:
        api = UpstoxClient(settings.upstox_access_token)
        symbols = [symbol for symbol in INDEXES if symbol != "INDIA_VIX"]
        results = await asyncio.gather(*(api.futures_search(symbol) for symbol in symbols))
        contracts = []
        for symbol, matches in zip(symbols, results):
            candidates = [item for item in matches if item.get("instrument_type") == "FUT" and item.get("instrument_key")]
            if candidates:
                # The API filters to current_month; prefer the earliest valid expiry returned.
                contract = sorted(candidates, key=lambda item: item.get("expiry", "9999-12-31"))[0]
                contracts.append((symbol, contract))
        quotes = await api.quotes([item["instrument_key"] for _, item in contracts]) if contracts else {}
        rows = []
        for symbol, contract in contracts:
            item = next((value for value in quotes.values() if value.get("instrument_token") == contract["instrument_key"]), None)
            if not item:
                continue
            spot = INDEXES[symbol]
            spot_item = None
            # Include spot keys in the same quote request on the next request; see request keys below.
            rows.append({"symbol": symbol, "tradingSymbol": contract.get("trading_symbol"), "expiry": contract.get("expiry"), "instrumentKey": contract["instrument_key"], "lastPrice": item.get("last_price"), "change": item.get("net_change"), "oi": item.get("oi"), "previousOi": item.get("previous_oi"), "spotKey": spot, "spot": spot_item})
        return {"mode": "snapshot", "status": "connected", "asOf": now_iso(), "rows": rows, "message": None}
    except UpstoxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.get("/api/option-chain/{symbol}")
async def option_chain(symbol: str, expiry: str = Query(default="current_month"), x_dashboard_password: str | None = Header(default=None)):
    require_password(x_dashboard_password)
    normalized = validate_option_symbol(symbol)
    if not settings.upstox_access_token:
        return {"mode": "demo", "status": "token_missing", "rows": [], "asOf": None}
    try:
        api = UpstoxClient(settings.upstox_access_token)
        rows = await api.option_chain(INDEXES[normalized], expiry)
        return {"mode": "snapshot", "status": "connected", "rows": rows, "asOf": now_iso()}
    except UpstoxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.websocket("/ws")
async def websocket(websocket: WebSocket):
    await websocket.accept()
    try:
        auth_frame = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        password = auth_frame.get("password", "") if isinstance(auth_frame, dict) else ""
        if not settings.dashboard_password or not secrets.compare_digest(password, settings.dashboard_password):
            await websocket.close(code=1008, reason="Access denied")
            return
        while True:
            data = await snapshot()
            data["serverTime"] = now_iso()
            await websocket.send_json(data)
            await asyncio.sleep(max(5, min(settings.snapshot_interval_seconds, 60)))
    except (WebSocketDisconnect, asyncio.TimeoutError):
        return
    except Exception as exc:
        logger.warning("Dashboard WebSocket ended (%s)", type(exc).__name__)
        try:
            await websocket.close(code=1011, reason="Temporary server error")
        except Exception:
            pass

@app.get("/api/candles/{symbol}")
async def candles(
    symbol: str,
    timeframe: str = Query(default="daily", pattern="^(daily|intraday)$"),
    x_dashboard_password: str | None = Header(default=None),
):
    require_password(x_dashboard_password)
    normalized = symbol.upper()
    if normalized not in INDEXES:
        raise HTTPException(status_code=404, detail="Unknown market index")
    if not settings.upstox_access_token:
        return {"mode": "demo", "status": "token_missing", "symbol": normalized, "timeframe": timeframe, "candles": [], "asOf": None}
    try:
        rows = await UpstoxClient(settings.upstox_access_token).candles(INDEXES[normalized], timeframe)
        return {"mode": "snapshot", "status": "connected", "symbol": normalized, "timeframe": timeframe, "candles": rows, "asOf": now_iso()}
    except UpstoxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
