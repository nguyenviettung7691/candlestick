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

This starts:

- Next.js app on [http://localhost:3000](http://localhost:3000)
- Mock WebSocket server on [ws://localhost:8787](ws://localhost:8787)

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
pip install -r requirements-dev.txt
pytest tests/test_indicators.py
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

### Backend Lambda environment variables

- DYNAMODB_TABLE_NAME (default: CandlestickDashboardTable)
- WEBSOCKET_API_ENDPOINT (required in deployed environments)
- WS_CONNECTION_TTL_SECONDS (default: 3600)
- POLL_INTERVAL_SECONDS (default: 10)
- MAX_RUNTIME_SECONDS (default: 52)
- PRICE_HISTORY_SIZE (default: 100, minimum: 30)
- STOCK_DATA_SOURCE (default: VCI)

## Real Data Source Integration

The polling Lambda is integrated with a real stock data provider via `vnstock3`:

- `backend/lambda_polling/app.py` initializes `Vnstock()`.
- For each active dashboard symbol, it fetches daily candles using:
   - `stock_engine.stock(symbol=<SYMBOL>, source=STOCK_DATA_SOURCE)`
   - `.trading.history(period="1D", size=PRICE_HISTORY_SIZE)`
- Indicator outputs are computed from these fetched candles and streamed to WebSocket clients.

Notes:

- Local `npm run dev:local` still uses the mock WebSocket simulator for frontend development.
- Deployed environments use live market data through Lambda, not the mock script.
- Symbol values loaded from DynamoDB are normalized to uppercase before provider requests.

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
   }
}
```

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
  - Ensure NEXT_PUBLIC_WEBSOCKET_URL points to ws:// (or allow auto-conversion from http/https in the hook).
- Empty dashboard rows:
  - Verify dashboardId matches one of the mock dashboards or deployed dashboard records.
- SAM validation/deploy issues:
  - Confirm SAM CLI is installed and AWS credentials are configured.

## License

This project is licensed under the terms in LICENSE.
