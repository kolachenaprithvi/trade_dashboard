# Tradely Index Terminal

A private NSE index F&O dashboard foundation with a React + Vite + TypeScript frontend and a FastAPI backend. The backend owns all Upstox calls and secrets. The UI supports NIFTY, BANK NIFTY, FINNIFTY, MIDCPNIFTY and India VIX, with index overview, futures, option chain, OI analytics, technicals, and connection freshness modules.

## Current data behavior

- With no `UPSTOX_ACCESS_TOKEN`, the app shows clearly labeled demo/empty states. It never invents prices.
- With a valid server-side Upstox access token, index quotes, option contracts/chain, and daily OHLC snapshots can be requested. Upstox says manual access tokens are generated from Developer Apps; auth is OAuth, and the access token is sent as a bearer token. Tokens should be treated as private and may need regular regeneration.
- The browser connects to the backend WebSocket, which relays snapshot refreshes and heartbeat/freshness state. This is **snapshot mode**, not Upstox's streaming Market Data Feed V3. The official V3 feed requires a bearer-authenticated WebSocket, follows a redirect, and uses binary Protobuf messages. Implementing that upstream feed safely requires confirming the exact account entitlement and testing its current Protobuf schema with your token. No feed scope is assumed here.
- Futures and derived analytics remain empty until an actual futures contract mapping/feed is configured. Option-chain OI comes from the official option-chain response when available; PCR is computed only from returned call/put OI.

## Local run

1. Copy `.env.example` to `.env` in the repository root and set a long `DASHBOARD_PASSWORD`. Keep `UPSTOX_ACCESS_TOKEN` blank for an empty-state preview, or set it privately in your local environment. Never paste a real token into source files or commit it.
2. Backend (Python 3.11+):

   ```sh
   cd backend
   python -m venv .venv
   # Windows: .venv\\Scripts\\Activate.ps1
   # macOS/Linux: source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn app.main:app --reload --port 8000
   ```

3. Frontend (Node 20+):

   ```sh
   cd frontend
   npm install
   npm run dev
   ```

The Vite dev server proxies `/api` and `/ws` to `http://localhost:8000`. Enter `DASHBOARD_PASSWORD` in the app's access prompt. The browser keeps that password only for its current tab session.

## Private zero-cost hosting outline

This workspace is not yet a Git repository. Push it to a private GitHub repository before applying the root-level `render.yaml` Blueprint. The Blueprint creates the backend from the `backend/` directory and prompts you to set `DASHBOARD_PASSWORD` privately.

### Render backend

- Apply the root `render.yaml` Blueprint to create the **Web Service** from `backend/`. The Blueprint prompts you for `DASHBOARD_PASSWORD`. When ready, add `UPSTOX_ACCESS_TOKEN` in Render Environment. After creating the Cloudflare Pages site, set `CORS_ORIGINS` to its exact origin. Do not place credentials in build arguments, frontend variables, logs, or Git.
- Free instances sleep after 15 minutes without inbound HTTP/WebSocket traffic, can take about a minute to wake, and have an ephemeral filesystem. This app doesn't rely on local persistence. It is unsuitable for uninterrupted intraday monitoring on the free tier.
- For stronger private access, put the Pages hostname behind Cloudflare Access and restrict it to your identity. The backend's password gate remains enabled as a second app-level check.

### Cloudflare Pages frontend

- Create a Pages project from the private repository; root directory `frontend`, build command `npm ci && npm run build`, output directory `dist`.
- Set `VITE_API_BASE_URL` to the Render service URL, for example `https://your-service.onrender.com`.
- Add the Pages production URL to backend `CORS_ORIGINS`, then redeploy the backend.
- Pages static assets are suitable for the free tier; serverless Functions have separate request quotas. This frontend uses a static build and calls the Render API directly.

Do not publish or deploy until you have reviewed the repository and set private access controls. Free-tier terms and quotas can change; verify provider dashboards before relying on them.

## API and security

- `GET /api/health` reports readiness without revealing credentials.
- `GET /api/dashboard` returns index snapshots if configured.
- `GET /api/option-chain/{symbol}?expiry=current_week` fetches an option chain.
- `WS /ws` is authenticated by a password in the first WebSocket frame (browser WebSockets do not support custom authorization headers). Use HTTPS/WSS in deployment. The REST API uses `X-Dashboard-Password`.
- The backend redacts bearer tokens and password values from errors/logging. Do not enable request header/body logging at the proxy.

## Official API references checked (2 Nov 2026)

- [Upstox Authentication](https://upstox.com/developer/api-documentation/authentication/)
- [Upstox Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/)
- [Upstox Full Market Quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
- [Upstox Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)
- [Upstox Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [Render Free Services](https://render.com/docs/free)
- [Cloudflare Pages Functions Pricing](https://developers.cloudflare.com/pages/functions/pricing/)
