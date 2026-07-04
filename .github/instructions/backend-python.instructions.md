---
description: "Use when editing backend Lambda Python files, indicator math, DynamoDB access, or WebSocket broadcast logic. Covers contracts, safety checks, and test expectations."
name: "Backend Python Lambda Rules"
applyTo: "backend/**/*.py"
---

# Backend Python Lambda Rules

- Keep indicator output contract exactly `{"metric": float, "signal": str}`.
- Preserve existing signal names (`BUY`, `SELL`, `NEUTRAL`, `SHOCK_ACCUMULATION`, `SHOCK_DISTRIBUTION`, `BUY_OVERSOLD`, `SELL_OVERBOUGHT`, `BULLISH_TREND`, `BEARISH_TREND`).
- Keep indicator functions deterministic and side-effect free; avoid mutating caller-owned data frames when possible.
- Maintain DynamoDB pagination handling for scans/queries (`LastEvaluatedKey`) in polling and connection cleanup paths.
- Only prune stale WebSocket connections on known stale/gone/forbidden signals; do not delete on transient errors.
- Preserve environment-variable driven runtime controls (`POLL_INTERVAL_SECONDS`, `MAX_RUNTIME_SECONDS`, `PRICE_HISTORY_SIZE`, `WS_CONNECTION_TTL_SECONDS`, etc.).
- Keep payload serialization UTF-8 safe and JSON compatible for API Gateway Management API.
- If behavior changes, add or adjust pytest coverage in `backend/lambda_polling/tests/test_indicators.py` (or add focused tests nearby).
