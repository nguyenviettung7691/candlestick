# VNINDEX Indicator Tracking Dashboard

Serverless, scale-to-zero dashboard for VNINDEX indicator tracking using AWS Lambda, DynamoDB, API Gateway WebSocket, and a Next.js frontend.

## Current status

The repository now contains the first implementation slice:

- Python indicator engine and polling Lambda scaffold under `backend/lambda_polling`
- WebSocket connection handler scaffold under `backend/lambda_websocket`
- Initial Next.js/Tailwind frontend scaffold under `frontend`
- AWS SAM template skeleton under `backend/template.yaml`
- WebSocket connection rows now use a relative TTL (`WS_CONNECTION_TTL_SECONDS`) and store `connected_at` so ephemeral records expire consistently instead of sharing a hard-coded absolute epoch.
- WebSocket connect events now reject missing connection IDs early, normalize dashboard IDs, and reuse a paginated PK query for disconnect cleanup.
- The frontend WebSocket hook now auto-converts `http(s)` deployment URLs to `ws(s)` before connecting, and the chart component maps lightweight-charts markers to the required marker shape.
- The frontend stream lifecycle now exposes explicit connection states (`connecting`, `connected`, `reconnecting`) and validates packet shape/dashboard routing before mutating UI state.
- Redundant Python package marker files were removed from the Lambda folders so the backend tree stays minimal.
- A local endpoint-mapping WebSocket simulator is now available under `frontend/scripts/mock-websocket-stream.mjs` for UI development without cloud infrastructure.
- Unit tests now cover the indicator engine under `backend/lambda_polling/tests/test_indicators.py` with pytest.
- The SAM template now includes deployment-oriented controls for schedule state, runtime knobs, table name, and data source settings.
- DynamoDB protections were added in the SAM stack with server-side encryption, optional point-in-time recovery, and retain policies for replacement/deletion safety.
- Operational observability was expanded with Lambda log-retention resources, WebSocket API access logs, optional X-Ray tracing, and a dedicated `wss://` client endpoint output.

## SAM infrastructure blueprint improvements

The deployment template in `backend/template.yaml` has been refactored to support safer production rollouts and easier environment-specific tuning.

### Refactor highlights

- Parameterized deployment inputs for table naming, schedule state/expression, polling runtime, memory, and stock source selection.
- Data durability defaults for DynamoDB: encryption enabled, optional PITR switch, and retained table on stack replacement/deletion.
- Observability defaults: Lambda log groups with retention, WebSocket API access logs with structured format, and optional X-Ray tracing.
- Added output for WebSocket client usage (`WebSocketClientEndpoint`) in addition to management endpoint output.

### Deployment inputs (SAM parameters)

- `DashboardTableName`
- `StageName`
- `WebSocketApiName`
- `PollingScheduleExpression`
- `PollingScheduleState`
- `WebSocketConnectionTtlSeconds`
- `PollIntervalSeconds`
- `MaxRuntimeSeconds`
- `PriceHistorySize`
- `StockDataSource`
- `FunctionTimeoutSeconds`
- `FunctionMemorySize`
- `DynamoPointInTimeRecovery`
- `LambdaLogRetentionDays`
- `WebSocketAccessLogRetentionDays`
- `EnableXRayTracing`

### Example guided deploy

From `backend`:

```bash
sam deploy --guided \
   --parameter-overrides \
      StageName=prod \
      PollingScheduleState=ENABLED \
      DynamoPointInTimeRecovery=ENABLED \
      EnableXRayTracing=ENABLED
```

For non-production environments, consider `PollingScheduleState=DISABLED` and shorter log retention values to reduce cost.

## Indicator engine upgrades

The core math engine in `backend/lambda_polling/indicators.py` has been strengthened for production data quality and cross-symbol comparability.

- MTF scoring now uses confidence-adjusted timeframe weighting. Sparse weekly/monthly data is down-weighted instead of forcing a neutral `50` contribution at full weight.
- LS-DVP now requires both abnormal volume and meaningful price body-vs-ATR movement to classify shock accumulation/distribution, reducing false positives.
- MR-ZSB now defaults to robust z-score mode (median + MAD scale) and computes baseline from prior bars only, reducing outlier sensitivity and avoiding same-bar baseline leakage.
- ATRM metric is now normalized in basis points (`bps`) relative to current close, with a neutral dead-zone threshold (`min_delta_bps`) to reduce whipsaw signals.

### Tunable parameters

- `calculate_mtf_scoring`: `w_1d`, `w_1w`, `w_1m`, `lookback`, `confidence_power`
- `calculate_ls_dvp`: `volume_ma`, `shock_threshold`, `atr_period`, `min_body_atr`
- `calculate_mr_zsb`: `ma_period`, `entry_z`, `robust`
- `calculate_atrm`: `fast_ema`, `slow_ema`, `min_delta_bps`

All indicator functions preserve the return shape `{ "metric": float, "signal": str }` for compatibility with the polling lambda and frontend payload mapping.

## Polling Lambda hardening

The main polling loop in `backend/lambda_polling/app.py` has been updated for better reliability under real Lambda execution limits and larger DynamoDB datasets.

- DynamoDB scans now handle pagination (`LastEvaluatedKey`) so dashboards and connections are not silently missed.
- Streaming payloads are now scoped per dashboard symbol mapping (`DASH#...` to `SYMBOL#...`) instead of broadcasting the full symbol universe to every connection.
- API Gateway Management client creation is now lazy and validates endpoint configuration before posting.
- Connection pruning now only deletes known stale websocket records (410/Gone/Forbidden paths) instead of deleting on any transient error.
- Runtime budget is now context-aware: the loop caps itself against `context.get_remaining_time_in_millis()` with a safety buffer.
- Symbol ingestion failures are isolated per ticker so one bad symbol does not fail the full cycle.
- Stream packets now include `as_of_epoch` to make client-side staleness checks easier.

### Polling environment variables

- `DYNAMODB_TABLE_NAME` (default: `VnIndexDashboardTable`)
- `WEBSOCKET_API_ENDPOINT` (required in deployed environments)
- `POLL_INTERVAL_SECONDS` (default: `10`)
- `MAX_RUNTIME_SECONDS` (default: `52`)
- `PRICE_HISTORY_SIZE` (default: `100`, minimum `30`)
- `STOCK_DATA_SOURCE` (default: `VCI`)

## Frontend layout improvements

The dashboard UI now includes targeted layout and usability upgrades for charting and dense metric tables.

- `AnalysisChart` now uses `ResizeObserver` to react to container width changes (not just window resize), improving rendering behavior in responsive layouts.
- The chart panel now shows a session delta and percentage change derived from the latest two bars for quicker at-a-glance context.
- The chart now includes an explicit empty-state overlay (`Waiting for chart history...`) so loading/no-data conditions are clear.
- The chart feed now uses rolling, symbol-scoped candle history synthesized from streamed prices and supports quick symbol switching chips above the chart.
- Chart bars are normalized by timestamp (sorted + de-duplicated) before rendering to avoid malformed or out-of-order updates.
- `MetricsTable` now supports horizontal scrolling on narrow viewports (`overflow-x-auto`) and uses a minimum table width to avoid clipped columns on mobile.
- Indicator signals in the table are now rendered as color-coded badges (with no-wrap labels), and numeric rendering uses locale formatters for more stable readability.

## Local mock testing matrix

You can simulate API Gateway-style WebSocket packets locally to test Next.js layout and streaming behavior without deploying AWS resources.

### Endpoint contract

- Local mock endpoint: `ws://localhost:8787`
- Query parameter used by the hook: `dashboardId`
- Stream packet shape:

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

### Run locally

From `frontend`:

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `frontend/.env.local.example` to `frontend/.env.local` and adjust values if needed.

3. Run Next.js and the mock stream together:

   ```bash
   npm run dev:local
   ```

Available mock dashboard IDs:

- `dash_01`
- `banking`
- `steel`

You can also run the stream server alone with `npm run mock:ws` and the frontend separately with `npm run dev`.

### Optional mock environment variables

- `NEXT_PUBLIC_WEBSOCKET_URL` (default: `ws://localhost:8787`)
- `NEXT_PUBLIC_DASHBOARD_ID` (default: `dash_01`)
- `MOCK_WS_HOST` (default: `0.0.0.0`)
- `MOCK_WS_PORT` (default: `8787`)
- `MOCK_WS_INTERVAL_MS` (default: `2000`)

## Backend unit tests

From `backend/lambda_polling`:

1. Install test dependencies:

   ```bash
   pip install -r requirements-dev.txt
   ```

2. Run indicator tests:

   ```bash
   pytest tests/test_indicators.py
   ```

Test coverage includes:

- Output payload contract for all indicators
- Confidence-adjusted MTF weighting behavior
- LS-DVP shock gating using body-vs-ATR and volume conditions
- MR-ZSB prior-window baseline behavior
- ATRM dead-zone neutral signaling and period validation

## SAM validation note

The template is editor-valid in this workspace, but `sam validate` could not be executed locally because SAM CLI is not installed in the current shell environment.
