# Candlestick Project Guidelines

## Scope And Architecture
- This repository has two main parts: Python AWS Lambda services in `backend/` and a Next.js App Router frontend in `frontend/`.
- Keep backend and frontend contracts aligned, especially the WebSocket stream payload consumed by the dashboard.
- Prefer small, targeted changes that preserve existing behavior unless the task explicitly asks for refactoring.

## Backend Contract Rules
- Keep indicator function return shape stable as `{"metric": float, "signal": str}`.
- Preserve stream packet shape used by the UI:
  - `dashboard_id`, `connection_id`, optional `as_of_epoch`, and `data` map.
- Keep WebSocket connection rows keyed by `PK=WS_CONNECTION#{id}` and dashboard `SK=DASHBOARD#{id}`.
- Connection TTL must remain relative (`connected_at + WS_CONNECTION_TTL_SECONDS`), not a hard-coded epoch.
- For DynamoDB scans/queries used in polling or cleanup, maintain pagination handling.

## Frontend Contract Rules
- Keep TypeScript types in `frontend/src/lib/types.ts` as the source of truth for stream payloads.
- Validate incoming WebSocket payloads before state updates in `useWebSocket`.
- Preserve chart/table responsiveness and mobile-safe behavior (ResizeObserver and horizontal scrolling).

## Build And Test
- Frontend install and lint:
  - `cd frontend`
  - `npm install`
  - `npm run lint`
- Frontend local dev with mock stream:
  - `npm run dev:local`
- Backend indicator tests:
  - `cd backend/lambda_polling`
  - `pip install -r requirements-dev.txt`
  - `pytest tests/test_indicators.py`

## Implementation Preferences
- Python: prefer typed, side-effect-light functions and clear guard clauses.
- TypeScript/React: keep client hooks/components focused and strongly typed.
- Do not introduce new frameworks or large dependencies unless required by the task.
- When changing behavior, update or add tests in the same area.

## Reference Docs
- See `README.md` for run/deploy workflow and runtime environment details.
- See `BLUEPRINT.md` for architecture intent and indicator/domain background.
