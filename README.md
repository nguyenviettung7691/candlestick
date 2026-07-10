# Candlestick

Candlestick is a serverless, scale-to-zero market analytics dashboard that streams indicator snapshots over WebSocket to a Next.js frontend.

It combines:

- AWS Lambda polling and stream broadcast
- DynamoDB single-table storage for dashboards and active WebSocket connections
- API Gateway WebSocket routes for real-time delivery
- A responsive Next.js dashboard with chart and metrics table views

## Table of Contents

- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Features](#features)
- [Implemented UI Coverage](#implemented-ui-coverage)
- [Prerequisites](#prerequisites)
- [Quick Start (Local Frontend + Mock Stream)](#quick-start-local-frontend--mock-stream)
- [Backend Indicator Tests](#backend-indicator-tests)
- [Deploy Backend With AWS SAM](#deploy-backend-with-aws-sam)
- [Configuration](#configuration)
- [Real Data Source Integration](#real-data-source-integration)
- [Stream Payload Contract](#stream-payload-contract)
- [Indicator Contracts](#indicator-contracts)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Architecture

Candlestick uses a hydrate-then-stream pattern:

1. A scheduled polling Lambda fetches market data and computes indicators.
2. The Lambda reads active dashboard-to-symbol mappings from DynamoDB.
3. Scoped payloads are posted to active WebSocket connections.
4. The frontend validates packets and updates chart/table state in real time.

## Repository Structure

```text
backend/
   template.yaml                  # AWS SAM stack: DynamoDB, Lambdas, WebSocket API
   lambda_polling/
      app.py                       # Polling loop + scoped broadcast
      indicators.py                # MTF, LS-DVP, MR-ZSB, ATRM calculations
      tests/test_indicators.py     # Indicator contract and behavior tests
   lambda_websocket/
      connection.py                # $connect/$disconnect/$default handlers

frontend/
   src/app/                       # Next.js App Router pages/layout
   src/hooks/useWebSocket.ts      # WebSocket lifecycle + packet validation
   src/components/                # Chart + metrics table components
   src/lib/types.ts               # Shared frontend stream types
   scripts/mock-websocket-stream.mjs
                                                # Local WebSocket simulator
```

## Features

- Serverless runtime with scale-to-zero economics
- Connection TTL and cleanup for ephemeral WebSocket rows
- Dashboard-scoped symbol routing for stream payloads
- Pagination-safe DynamoDB scan/query paths in Lambda workflows
- Frontend connection state model: connecting, connected, reconnecting
- Chart and metrics table optimized for desktop and mobile layouts
- Local mock stream for UI development without cloud deployment

## Implemented UI Coverage

- Multi-dashboard selector with add and edit flows in the header.
- Active indicator badge for the selected dashboard.
- Indicator management flow for built-in indicators, custom indicator drafts, parameter editing, and assignment back to a dashboard.
- Notification rule management with validation, in-app event feed, and optional browser push delivery when VAPID configuration is present.
- Dashboard table and chart interaction where selecting a row focuses the detail chart and timerange changes only affect the chart window.
- Stream packet validation before React state updates, including optional notification events.

## Prerequisites

- Node.js 18+
- npm 9+
- Python 3.11+
- pip
- AWS SAM CLI (required only for deployment/stack validation)
- AWS credentials configured (required only for deployment)

## Quick Start (Local Frontend + Mock Stream)

Run from frontend:

```bash
cd frontend
npm install
npm run dev:local
```

To replicate production-like real market price streaming on localhost (without AWS deployment):

```bash
cd frontend
npm run dev:local:real
```

This starts a Python WebSocket server backed by `vnstock` and reuses the backend indicator computation path used by production polling.

This starts:

- Next.js app on [http://localhost:3000](http://localhost:3000)
- Mock WebSocket server on [ws://localhost:8787](ws://localhost:8787) for `npm run dev:local`
- Local real stream server on [ws://localhost:8788](ws://localhost:8788) for `npm run dev:local:real`

Mock dashboard IDs:

- dash_01
- banking
- steel

You can also run each process separately:

```bash
cd frontend
npm run mock:ws
```

```bash
cd frontend
npm run dev
```

## Backend Indicator Tests

Run from backend/lambda_polling:

```bash
cd backend/lambda_polling
python -m pip install -r requirements-dev.txt
python -m pytest tests/test_indicators.py
```

Recommended (especially on Windows) to avoid interpreter/PATH mismatches:

```powershell
cd backend/lambda_polling
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python -m pytest tests/test_indicators.py
```

Covered behaviors include output contract enforcement and core indicator edge cases.

## Deploy Backend With AWS SAM

Run from backend:

```bash
cd backend
sam build
sam deploy --guided
```

Example deploy with explicit production-oriented overrides:

```bash
sam deploy --guided --parameter-overrides StageName=prod PollingScheduleState=ENABLED DynamoPointInTimeRecovery=ENABLED EnableXRayTracing=ENABLED
```

## Configuration

### Frontend environment variables

- NEXT_PUBLIC_WEBSOCKET_URL (default: ws://localhost:8787)
- NEXT_PUBLIC_DASHBOARD_ID (default: dash_01)

### Mock stream environment variables

- MOCK_WS_HOST (default: 0.0.0.0)
- MOCK_WS_PORT (default: 8787)
- MOCK_WS_INTERVAL_MS (default: 2000)

### Local vnstock stream environment variables

- LOCAL_VNSTOCK_WS_HOST (default: 0.0.0.0)
- LOCAL_VNSTOCK_WS_PORT (default: 8788)
- LOCAL_VNSTOCK_WS_INTERVAL_SECONDS (default: POLL_INTERVAL_SECONDS or 10)
- LOCAL_VNSTOCK_DASHBOARD_SYMBOLS_JSON (optional dashboard-to-symbol map JSON)

### Backend Lambda environment variables

- DYNAMODB_TABLE_NAME (default: CandlestickDashboardTable)
- WEBSOCKET_API_ENDPOINT (required in deployed environments)
- WS_CONNECTION_TTL_SECONDS (default: 3600)
- POLL_INTERVAL_SECONDS (default: 10)
- MAX_RUNTIME_SECONDS (default: 52)
- PRICE_HISTORY_SIZE (default: 100, minimum: 30)
- STOCK_DATA_SOURCE (default: VCI)
- VAPID_PUBLIC_KEY (required for browser push notifications)
- VAPID_PRIVATE_KEY (required for browser push notifications)
- VAPID_SUBJECT (required for browser push notifications)

### Frontend optional environment variables

- NEXT_PUBLIC_ENABLE_LOCAL_FALLBACK (default: false)
- SYMBOLS_API_URL (optional; server-side URL consumed by `/api/symbols` for live symbol catalog)
- SYMBOLS_API_AUTH_HEADER (optional header name when provider requires auth)
- SYMBOLS_API_AUTH_TOKEN (optional header value when provider requires auth)
- SYMBOLS_API_TIMEOUT_MS (optional request timeout in milliseconds, default: 5000)
- SYMBOLS_CACHE_TTL_SECONDS (optional symbol cache TTL for `/api/symbols`, default: 3600)
- VNSTOCK_SYMBOLS_TIMEOUT_MS (optional timeout for built-in VNStock symbol discovery, default: 45000)
- VNSTOCK_PYTHON_BIN (optional Python executable path for built-in VNStock symbol discovery)

## Real Data Source Integration

The polling Lambda is integrated with a real stock data provider via `vnstock`:

- `backend/lambda_polling/app.py` initializes `Vnstock()`.
- For each active dashboard symbol, it fetches daily candles using:
   - `stock_engine.stock(symbol=<SYMBOL>, source=STOCK_DATA_SOURCE)`
   - `.trading.history(period="1D", size=PRICE_HISTORY_SIZE)`
- Indicator outputs are computed from these fetched candles and streamed to WebSocket clients.

Notes:

- Local `npm run dev:local` still uses the mock WebSocket simulator for frontend development.
- Local `npm run dev:local:real` uses `vnstock` directly and computes metrics through the same backend function path used by production polling.
- Deployed environments use live market data through Lambda, not the mock script.
- Symbol values loaded from DynamoDB are normalized to uppercase before provider requests.
- Browser push notifications require valid VAPID settings in the backend environment.

## Symbol Catalog Integration

Dashboard symbol selection now uses a searchable symbol catalog instead of comma-separated input.

- The frontend resolves symbol options through `GET /api/symbols`.
- The route first tries a configured provider (`SYMBOLS_API_URL`) when available.
- If no provider is configured (or provider fetch fails), the route derives symbols from VNStock using the official Unified UI reference path (`Reference().equity.list()`) and normalizes the output for the modal selector.
- The route normalizes provider payloads to a stable shape: `symbol`, `companyName`, optional `exchange`.
- If both provider and VNStock discovery are unavailable, the app automatically falls back to built-in defaults (`FPT`, `HPG`, `VCB`) so local development remains usable.

### Validate live data end-to-end

1. Deploy backend with SAM and keep `PollingScheduleState=ENABLED`.
2. Ensure watchlist mappings exist in DynamoDB as `PK=DASH#<dashboard_id>`, `SK=SYMBOL#<ticker>`.
3. Set frontend `NEXT_PUBLIC_WEBSOCKET_URL` to your deployed WebSocket stage URL (`wss://...`).
4. Open the dashboard and confirm changing prices/metrics over successive polling intervals.

### Key SAM parameters

- DashboardTableName
- StageName
- WebSocketApiName
- PollingScheduleExpression
- PollingScheduleState
- WebSocketConnectionTtlSeconds
- PollIntervalSeconds
- MaxRuntimeSeconds
- PriceHistorySize
- StockDataSource
- FunctionTimeoutSeconds
- FunctionMemorySize
- DynamoPointInTimeRecovery
- LambdaLogRetentionDays
- WebSocketAccessLogRetentionDays
- EnableXRayTracing

## Stream Payload Contract

The frontend expects packets in this shape:

```json
{
   "dashboard_id": "dash_01",
   "connection_id": "local_ab12cd34",
   "as_of_epoch": 1785195600,
   "data": {
      "FPT": {
         "symbol": "FPT",
         "price": 128.25,
         "mtf_score": 77.2,
         "mtf_signal": "BUY",
         "ls_ratio": 2.14,
         "ls_signal": "SHOCK_ACCUMULATION",
         "z_score": 1.28,
         "z_signal": "NEUTRAL",
         "trend_delta": 15.2,
         "trend_signal": "BULLISH_TREND"
      }
   },
   "notifications": [
      {
         "id": "evt_01",
         "ruleId": "rule_01",
         "dashboardId": "dash_01",
         "symbol": "FPT",
         "message": "FPT crossed the configured threshold",
         "triggeredAtEpoch": 1785195600,
         "channels": {
            "inApp": true,
            "push": false
         }
      }
   ]
}
```

Notes:

- `notifications` is optional and only included when the backend has in-app or push events to deliver.
- The frontend validates `dashboard_id`, `connection_id`, ticker snapshots, and notification events before updating state.

## Indicator Contracts

Indicator functions return the stable contract:

```json
{ "metric": 0.0, "signal": "NEUTRAL" }
```

Supported signal set:

- BUY
- SELL
- NEUTRAL
- SHOCK_ACCUMULATION
- SHOCK_DISTRIBUTION
- BUY_OVERSOLD
- SELL_OVERBOUGHT
- BULLISH_TREND
- BEARISH_TREND

## Troubleshooting

- WebSocket not connecting locally:
  - Confirm mock server is running on [ws://localhost:8787](ws://localhost:8787).
   - If `npm run dev:local` exits with `EADDRINUSE`, another process already uses port `8787`; stop that process or set `MOCK_WS_PORT` to another value and update `NEXT_PUBLIC_WEBSOCKET_URL` accordingly.
  - Ensure NEXT_PUBLIC_WEBSOCKET_URL points to ws:// (or allow auto-conversion from http/https in the hook).
- Empty dashboard rows:
  - Verify dashboardId matches one of the mock dashboards or deployed dashboard records.
- SAM validation/deploy issues:
  - Confirm SAM CLI is installed and AWS credentials are configured.
- `pytest` is not recognized on Windows:
   - Use `python -m pytest tests/test_indicators.py` instead of `pytest ...`.
   - Install test deps with the same interpreter: `python -m pip install -r backend/lambda_polling/requirements-dev.txt`.
   - If needed, create and activate a virtual environment before installing and running tests.

## License

This project is licensed under the terms in LICENSE.
