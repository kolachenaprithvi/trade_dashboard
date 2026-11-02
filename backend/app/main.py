import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .upstox import INDEXES, UpstoxClient, UpstoxError

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
    return {"mode": "demo", "status": "token_missing", "asOf": None, "indices": {}, "technicals": {}, "message": "Add a server-side Upstox access token to enable market data."}


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
        data = await api.quotes(list(INDEXES.values()))
        technical_data = await api.ohlc(list(INDEXES.values()))
        quotes = {}
        for symbol, key in INDEXES.items():
            item = next((v for v in data.values() if v.get("instrument_token") == key), None)
            if item:
                quotes[symbol] = {"instrumentKey": item.get("instrument_token", key), "lastPrice": item.get("last_price"), "change": item.get("net_change"), "volume": item.get("volume"), "oi": item.get("oi"), "timestamp": item.get("timestamp"), "ohlc": item.get("ohlc")}
        return {"mode": "snapshot", "status": "connected", "asOf": now_iso(), "indices": quotes, "technicals": technical_data, "message": None}
    except UpstoxError as exc:
        return {"mode": "unavailable", "status": "upstream_error", "asOf": now_iso(), "indices": {}, "technicals": {}, "message": str(exc)}


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


@app.get("/api/option-chain/{symbol}")
async def option_chain(symbol: str, expiry: str = Query(default="current_week"), x_dashboard_password: str | None = Header(default=None)):
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
