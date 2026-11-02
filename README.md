# Tradely Index Terminal

Private NSE index F&O dashboard with a React + Vite + TypeScript frontend and FastAPI backend. The GitHub source repository is public as requested; dashboard API access is password-protected. Supported instruments: NIFTY, BANK NIFTY, FINNIFTY, MIDCPNIFTY and India VIX.

## Data and safety

- Without UPSTOX_ACCESS_TOKEN, the UI uses explicit empty/demo states and never invents live prices.
- All Upstox calls and credentials stay on the backend. Never commit tokens or passwords. Set them only in local environment variables or the hosting provider's secret settings.
- The backend currently relays snapshot refreshes over its WebSocket. This is not Upstox Market Data Feed V3. Futures and analytics remain empty until real contract mapping/feed data is configured.
- API routes require DASHBOARD_PASSWORD; REST uses X-Dashboard-Password, WebSocket authenticates with the first frame.

## Run locally

1. Copy .env.example to .env, set a long DASHBOARD_PASSWORD, and leave UPSTOX_ACCESS_TOKEN blank for a safe empty-state preview.
2. Start the backend (Python 3.11+):

    cd backend
    python -m venv .venv
    # Windows: .venv\Scripts\Activate.ps1
    # macOS/Linux: source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000

3. In another terminal, start the frontend (Node 20+):

    cd frontend
    npm ci
    npm run dev

Open the Vite URL and enter the same dashboard password. The Vite server proxies /api and /ws to localhost:8000.

## Cloud hosting

Target: Cloudflare Pages frontend and Render free backend. The Render free service can sleep when idle and has ephemeral storage, so it is not suitable for uninterrupted intraday monitoring. No persistence is required by this MVP.

### Render

- Apply the root render.yaml Blueprint from the public repository. Set DASHBOARD_PASSWORD privately when prompted.
- Set UPSTOX_ACCESS_TOKEN later in the Render service's Environment settings. The access token is optional for the empty-state UI.
- Once the Pages hostname exists, set CORS_ORIGINS to that exact origin in Render and redeploy.

### Cloudflare Pages

- Connect this repository; root directory frontend; build command npm ci && npm run build; output directory dist.
- Set build variable VITE_API_BASE_URL to the Render service URL, for example https://your-service.onrender.com.
- Configure Cloudflare Access on the Pages hostname to restrict it to your identity; the dashboard password remains an additional check.

## API

- GET /api/health returns readiness without disclosing credentials.
- GET /api/dashboard returns available index snapshots.
- GET /api/option-chain/{symbol}?expiry=current_week fetches an option chain.
- The server redacts bearer tokens/passwords in errors and logs. Avoid proxy request header/body logging.

Official references checked 2 Nov 2026: [Upstox auth](https://upstox.com/developer/api-documentation/authentication/), [Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/), [Full Market Quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/), [Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/), [Render free services](https://render.com/docs/free).
