# Tradely Index Terminal

A private NSE index F&O dashboard foundation with a React + Vite + TypeScript frontend and a FastAPI backend. The backend owns all Upstox calls and secrets. The UI supports NIFTY, BANK NIFTY, FINNIFTY, MIDCPNIFTY and India VIX, with index overview, futures, option chain, OI analytics, technicals, and connection freshness modules.

## Current data behavior

- With no `UPSTOX_ACCESS_TOKEN`, the app shows clearly labeled demo/empty states. It never invents prices.
- With a valid server-side Upstox access token, index quotes, daily OHLC snapshots, and live quotes for SBI, Axis Bank, ICICI Bank, HDFC Bank, and Kotak Mahindra Bank can be requested. The bank box shows quotes and price change only; it does not invent constituent weights. Upstox says manual access tokens are generated from Developer Apps; auth is OAuth, and the access token is sent as a bearer token. Tokens should be treated as private and may need regular regeneration.
- The browser connects to the backend WebSocket, which relays snapshot refreshes and heartbeat/freshness state. This is **snapshot mode**, not Upstox's streaming Market Data Feed V3. The official V3 feed requires a bearer-authenticated WebSocket, follows a redirect, and uses binary Protobuf messages. Implementing that upstream feed safely requires confirming the exact account entitlement and testing its current Protobuf schema with your token. No feed scope is assumed here.
- The Futures tab resolves current-month index contracts through Upstox Instrument Search and displays returned futures quotes, spot basis, and OI change when Upstox supplies the fields. OI Analytics loads the current option chain and computes PCR/OI totals from returned strikes. Overview shows the live snapshot and session OHLC. The Technicals and Strategy Lab views request daily candles for EMA 20/50, RSI 14, MACD histogram, and Supertrend (10, 3). The option chain defaults to the five strikes on either side of ATM and can be expanded to all returned strikes.

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

The project source is available in this public GitHub repository. Apply the root `render.yaml` Blueprint to create the backend from `backend/`. The Blueprint prompts you to set `DASHBOARD_PASSWORD` in Render. Keep credentials out of this public repository.

### Render backend

- Apply the root `render.yaml` Blueprint to create the **Web Service** from `backend/`. The Blueprint prompts you for `DASHBOARD_PASSWORD`. When ready, add `UPSTOX_ACCESS_TOKEN` in Render Environment. After creating the Cloudflare Pages site, set `CORS_ORIGINS` to its exact origin. Do not place credentials in build arguments, frontend variables, logs, or Git.
- Free instances sleep after 15 minutes without inbound HTTP/WebSocket traffic, can take about a minute to wake, and have an ephemeral filesystem. This app doesn't rely on local persistence. It is unsuitable for uninterrupted intraday monitoring on the free tier.
- For stronger private access, put the Pages hostname behind Cloudflare Access and restrict it to your identity. The backend's password gate remains enabled as a second app-level check.

### Cloudflare Pages frontend

- Create a Pages project from this repository; root directory `frontend`, build command `npm ci && npm run build`, output directory `dist`.
- Set `VITE_API_BASE_URL` to the Render service URL, for example `https://your-service.onrender.com`.
- Add the Pages production URL to backend `CORS_ORIGINS`, then redeploy the backend.
- Pages static assets are suitable for the free tier; serverless Functions have separate request quotas. This frontend uses a static build and calls the Render API directly.

The repository is public, but dashboard API routes are password-protected. Configure Cloudflare Access for the Pages site as an additional private access layer before sharing its URL. Free-tier terms and quotas can change; verify provider dashboards before relying on them.

## API and security

- `GET /api/health` reports readiness without revealing credentials.
- `GET /api/dashboard` returns index snapshots if configured.
- `GET /api/option-chain/{symbol}?expiry=current_week` fetches an option chain.
- `GET /api/futures` resolves current-month index futures and fetches their quotes.
- `GET /api/candles/{symbol}?timeframe=daily` returns verified daily candles for technical analysis.
- `WS /ws` is authenticated by a password in the first WebSocket frame (browser WebSockets do not support custom authorization headers). Use HTTPS/WSS in deployment. The REST API uses `X-Dashboard-Password`.
- The backend redacts bearer tokens and password values from errors/logging. Do not enable request header/body logging at the proxy.

## Official API references checked (3 Nov 2026)

- [Upstox Authentication](https://upstox.com/developer/api-documentation/authentication/)
- [Upstox Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/)
- [Upstox Full Market Quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
- [Upstox Instrument Search](https://upstox.com/developer/api-documentation/instrument-search/)
- [Upstox Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)
- [Upstox Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [Upstox Historical Candle Data V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
- [Render Free Services](https://render.com/docs/free)
- [Cloudflare Pages Functions Pricing](https://developers.cloudflare.com/pages/functions/pricing/)


## Indicators and strategy context

- Indicator calculations use daily OHLC candles returned by Upstox. Missing history or insufficient bars produce empty indicator values, never synthetic data.
- Strategy Lab can display an aligned debit vertical only when EMA 20/50 and Supertrend agree and both option legs have usable bid/ask quotes. Premiums, maximum loss, maximum gain, and breakeven are per index point; lot size and charges are not included.
- The dashboard does not claim a spread win rate or predictive probability. A credible rate requires historical option-chain prices, conservative fills, costs, and out-of-sample validation. The displayed swing context and spread are research aids, not orders or a guarantee of results.
