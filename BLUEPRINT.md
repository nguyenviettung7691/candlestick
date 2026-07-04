# Project Overview And Objectives

Build a fully serverless, scale-to-zero web application for the Candlestick indicator tracking dashboard. The architecture uses a hydrate-then-stream pattern via AWS Lambda execution loops, eliminating the need for an always-on server or load balancer.

## Tech Stack Specifications

- **Frontend:** Next.js 14+ (App Router, TypeScript), Tailwind CSS, TanStack Table v8, Lightweight Charts (TradingView HTML5 Canvas)
- **Backend Runtime:** Python 3.11 (AWS Lambda optimized with NumPy/Pandas)
- **Database And WebSocket Gateway:** Amazon DynamoDB (single-table design), Amazon API Gateway (WebSocket API)
- **Scheduling And Security:** Amazon EventBridge (cron), AWS Secrets Manager (VAPID keys, sessions)

## 1. Project Directory Structure

Instruct the agent to generate the following file tree layout:

```text
backend/
  lambda_polling/
    app.py                 # Core Lambda loop (55-second execution)
    indicators.py          # Vectorized math engines (MTF, LS-DVP, MR-ZSB, ATRM)
    requirements.txt       # Dependencies: vnstock3, pandas, numpy, boto3
  lambda_websocket/
    connection.py          # Handles $connect, $disconnect, $default routes
  template.yaml            # AWS SAM / CloudFormation template
frontend/
  src/
    app/
      layout.tsx
      page.tsx             # Dashboard layout container
    components/
      MetricsTable.tsx     # TanStack Table list
      AnalysisChart.tsx    # TradingView canvas chart component
    hooks/
      useWebSocket.ts      # Reconnectable WS hook
    lib/
      types.ts             # Shared TypeScript interfaces
```

The Lambda folders are intentionally kept package-marker free; handlers are loaded as top-level modules inside their own deployment bundles.

## 2. Database Schema (DynamoDB Single-Table Specification)

Create a single table named `CandlestickDashboardTable` with:

- Partition key: `PK` (String)
- Sort key: `SK` (String)
- TTL attribute: `ttl` (for ephemeral items such as WebSocket connections)

Connection TTL values should be computed at write time as `connected_at_epoch + WS_CONNECTION_TTL_SECONDS`; do not hard-code a single absolute epoch for all connections.

```json
[
  {
    "Description": "Active Connection Item",
    "PK": "WS_CONNECTION#connectionId_abc123",
    "SK": "DASHBOARD#dash_01",
    "connected_at": 1785195600,
    "ttl": 1785199200
  },
  {
    "Description": "User Dashboard Item",
    "PK": "USER#user_99",
    "SK": "DASH#dash_01",
    "dashboard_name": "Banking Sector Screen",
    "indicator_id": "MTF_SCORING",
    "custom_params": "{\"w_1d\": 0.2, \"w_1w\": 0.3, \"w_1m\": 0.5, \"lookback\": 14}"
  },
  {
    "Description": "Watchlist Symbol Mapping",
    "PK": "DASH#dash_01",
    "SK": "SYMBOL#FPT",
    "ticker_code": "FPT",
    "company_name": "FPT Corporation"
  }
]
```

Notes:

- Persistent dashboard and user records should omit `ttl` so they are not deleted automatically.
- Connection records should keep the `SK` scoped to the dashboard because the poller and disconnect handler rely on that reverse lookup.
- If the connection lifetime changes, update `WS_CONNECTION_TTL_SECONDS` in deployment environment variables rather than changing the schema.

## 3. Core Backend Math Engine (`backend/lambda_polling/indicators.py`)

This file contains high-performance vectorized implementations of the four default quantitative frameworks.

```python
import numpy as np
import pandas as pd


def calculate_mtf_scoring(
    df_1d: pd.DataFrame, df_1w: pd.DataFrame, df_1m: pd.DataFrame, params: dict
) -> dict:
    """
    Multi-Timeframe Scoring Framework
    Formula: S_MTF = sum(w_t * ((C_t - L_n,t) / (H_n,t - L_n,t)) * 100)
    """
    w_1d = params.get("w_1d", 0.2)
    w_1w = params.get("w_1w", 0.3)
    w_1m = params.get("w_1m", 0.5)
    n = params.get("lookback", 14)

    def get_tier_score(df, lookback):
        if len(df) < lookback:
            return 50.0
        close = df["close"].iloc[-1]
        low_n = df["low"].tail(lookback).min()
        high_n = df["high"].tail(lookback).max()
        if high_n == low_n:
            return 50.0
        return ((close - low_n) / (high_n - low_n)) * 100.0

    s_1d = get_tier_score(df_1d, n)
    s_1w = get_tier_score(df_1w, n)
    s_1m = get_tier_score(df_1m, n)

    final_score = (w_1d * s_1d) + (w_1w * s_1w) + (w_1m * s_1m)
    signal = "BUY" if final_score > 75 else ("SELL" if final_score < 30 else "NEUTRAL")

    return {"metric": round(final_score, 2), "signal": signal}


def calculate_ls_dvp(df_1d: pd.DataFrame, params: dict) -> dict:
    """
    Liquidity Shock & Delta Volume Profile
    Tracks volume anomalies relative to 20-day MA alongside spread compression.
    """
    lookback = params.get("volume_ma", 20)
    multiplier = params.get("shock_threshold", 2.0)
    if len(df_1d) < lookback:
        return {"metric": 1.0, "signal": "NEUTRAL"}

    current_vol = df_1d["volume"].iloc[-1]
    ma_vol = df_1d["volume"].tail(lookback).mean()
    vol_ratio = current_vol / ma_vol if ma_vol > 0 else 1.0

    close = df_1d["close"].iloc[-1]
    open_p = df_1d["open"].iloc[-1]
    spread = abs(close - open_p)

    signal = "NEUTRAL"
    if vol_ratio >= multiplier:
        signal = "SHOCK_ACCUMULATION" if close >= open_p else "SHOCK_DISTRIBUTION"

    return {"metric": round(vol_ratio, 2), "signal": signal}


def calculate_mr_zsb(df_1d: pd.DataFrame, params: dict) -> dict:
    """
    Mean Reversion Z-Score Band
    Measures standard deviations from the historical moving average.
    """
    period = params.get("ma_period", 50)
    if len(df_1d) < period:
        return {"metric": 0.0, "signal": "NEUTRAL"}

    df_1d["ma"] = df_1d["close"].rolling(window=period).mean()
    df_1d["std"] = df_1d["close"].rolling(window=period).std()

    current_close = df_1d["close"].iloc[-1]
    current_ma = df_1d["ma"].iloc[-1]
    current_std = df_1d["std"].iloc[-1]

    z_score = (current_close - current_ma) / current_std if current_std > 0 else 0.0
    signal = (
        "BUY_OVERSOLD"
        if z_score < -2.0
        else ("SELL_OVERBOUGHT" if z_score > 2.0 else "NEUTRAL")
    )

    return {"metric": round(z_score, 2), "signal": signal}


def calculate_atrm(df_1d: pd.DataFrame, params: dict) -> dict:
    """
    Adaptive Trend Regime Matrix
    Calculates moving average trend tracking lines.
    """
    fast_p = params.get("fast_ema", 12)
    slow_p = params.get("slow_ema", 26)
    if len(df_1d) < slow_p:
        return {"metric": 0.0, "signal": "NEUTRAL"}

    fast_ema = df_1d["close"].ewm(span=fast_p, adjust=False).mean().iloc[-1]
    slow_ema = df_1d["close"].ewm(span=slow_p, adjust=False).mean().iloc[-1]
    delta = fast_ema - slow_ema

    signal = "BULLISH_TREND" if delta > 0 else "BEARISH_TREND"
    return {"metric": round(delta, 2), "signal": signal}
```

## 4. Main Polling Function (`backend/lambda_polling/app.py`)

This file implements the execution loop that handles streaming events within the 60-second threshold block.

```python
import os
import time
import asyncio
import boto3
import pandas as pd
from vnstock3 import Vnstock
from indicators import calculate_mtf_scoring, calculate_ls_dvp, calculate_mr_zsb, calculate_atrm

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table("CandlestickDashboardTable")

# Setup API Gateway Management API Client
apigw_client = boto3.client(
    "apigatewaymanagementapi",
    endpoint_url=os.environ["WEBSOCKET_API_ENDPOINT"],
)


def get_active_targets():
    # Scan for unique tickers mapped to open browser loops
    response = table.scan(
        FilterExpression=boto3.dynamodb.conditions.Attr("PK").begins_with("DASH#")
        & boto3.dynamodb.conditions.Attr("SK").begins_with("SYMBOL#")
    )
    tickers = list(set([item["ticker_code"] for item in response.get("Items", [])]))

    connections_resp = table.scan(
        FilterExpression=boto3.dynamodb.conditions.Attr("PK").begins_with("WS_CONNECTION#")
    )
    connections = connections_resp.get("Items", [])
    return tickers, connections


async def poll_and_broadcast():
    start_time = time.time()
    stock_engine = Vnstock()

    while time.time() - start_time < 52:
        loop_start = time.time()
        tickers, connections = get_active_targets()

        if not tickers or not connections:
            await asyncio.sleep(10)
            continue

        # Bulk extract live price fields using vnstock
        try:
            live_data = {}
            for ticker in tickers:
                # Pull daily raw dataset matrices
                stock_data = stock_engine.stock(symbol=ticker, source="VCI")
                df_1d = stock_data.trading.history(period="1D", size=100)

                # Mock weekly/monthly groupings for structural metrics framework
                df_1w = df_1d.resample("W", on="time").last() if "time" in df_1d.columns else df_1d
                df_1m = df_1d.resample("M", on="time").last() if "time" in df_1d.columns else df_1d

                live_price = float(df_1d["close"].iloc[-1])

                # Compute indicator profiles
                mtf = calculate_mtf_scoring(df_1d, df_1w, df_1m, {})
                ls_dvp = calculate_ls_dvp(df_1d, {})
                zsb = calculate_mr_zsb(df_1d, {})
                atrm = calculate_atrm(df_1d, {})

                live_data[ticker] = {
                    "symbol": ticker,
                    "price": live_price,
                    "mtf_score": mtf["metric"],
                    "mtf_signal": mtf["signal"],
                    "ls_ratio": ls_dvp["metric"],
                    "ls_signal": ls_dvp["signal"],
                    "z_score": zsb["metric"],
                    "z_signal": zsb["signal"],
                    "trend_delta": atrm["metric"],
                    "trend_signal": atrm["signal"],
                }
        except Exception as e:
            print(f"Data ingestion anomaly: {str(e)}")
            await asyncio.sleep(5)
            continue

        # Broadcast mapped metrics payloads to live WebSocket connections
        for conn in connections:
            try:
                conn_id = conn["PK"].split("#")[1]
                target_dash = conn["SK"].split("#")[1]

                # Filter down packet payload matrix data to match dashboard rules
                apigw_client.post_to_connection(
                    ConnectionId=conn_id,
                    Data=pd.Series(live_data).to_json(orient="records"),
                )
            except Exception:
                # Handle structural disconnects by pruning connection state pointers
                table.delete_item(Key={"PK": conn["PK"], "SK": conn["SK"]})

        elapsed = time.time() - loop_start
        sleep_duration = max(10 - elapsed, 1)
        await asyncio.sleep(sleep_duration)


def lambda_handler(event, context):
    asyncio.run(poll_and_broadcast())
    return {"statusCode": 200, "body": "Cycle complete"}
```

## 5. UI Layout Blueprint (`frontend/src/components/AnalysisChart.tsx`)

This component structures the canvas charts and handles the overlay logic.

```typescript
"use client";
import { useEffect, useRef } from "react";
import { createChart, IChartApi, ISeriesApi } from "lightweight-charts";

interface ChartProps {
  symbol: string;
  historicalData: any[]; // Array of structural bar data: { time, open, high, low, close }
  indicatorMarkers: any[]; // Array of alert points: { time, position, color, text }
}

export default function AnalysisChart({ symbol, historicalData, indicatorMarkers }: ChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create high-performance HTML5 canvas instance layout
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 400,
      layout: { background: { value: "#131722" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "#242832" }, horzLines: { color: "#242832" } },
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    candlestickSeries.setData(historicalData);
    candlestickSeries.setMarkers(indicatorMarkers);

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestickSeries;

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [historicalData, indicatorMarkers]);

  return (
    <div className="w-full bg-slate-900 p-4 rounded-xl shadow-lg border border-slate-800">
      <h3 className="text-lg font-bold text-slate-100 mb-2">Metrics Stream Visualization: {symbol}</h3>
      <div ref={chartContainerRef} className="w-full h-[400px]" />
    </div>
  );
}
```

## 6. Frontend Asset Notes

The active scaffold does not currently include a service worker. Keep Web Push assets out of the tree until the registration path and notification pipeline are wired into the Next.js app.

## 7. Execution Instructions For The Scaffolding Agent

Instruct your coding agent to follow these setup steps to assemble and run the workspace:

1. **Create Regulatory Git Files:** Create suitable `README.md`, `.gitignore`, and `LICENSE` files.
2. **Scaffold Directory Structures:** Initialize the backend as a Python workspace and the frontend as a Next.js TypeScript boilerplate.
3. **Inject Source Implementations:** Populate the provided Python file templates into `/backend` and core visualization components into `/frontend`.
4. **Configure Local Mock Testing Matrix:** Create a local development endpoint mapping script that simulates incoming WebSocket stream payloads from API Gateway to test the Next.js layout changes without running live cloud stacks.
5. **Deploy AWS Infrastructure Blueprint:** Spin up dependencies via AWS SAM using `sam deploy --guided`, or apply the resource matrix mappings directly in AWS service consoles.

### 7.1 Deployment Inputs And Hardening Controls (SAM)

The SAM template should expose deployment parameters so environments can be tuned without code edits.

- **Naming And Routing:** `DashboardTableName`, `StageName`, `WebSocketApiName`, `WebSocketRouteSelectionExpression`
- **Polling Control Plane:** `PollingScheduleExpression`, `PollingScheduleState`, `PollIntervalSeconds`, `MaxRuntimeSeconds`, `PriceHistorySize`, `StockDataSource`
- **Function Sizing:** `FunctionTimeoutSeconds`, `FunctionMemorySize`
- **Connection Lifecycle:** `WebSocketConnectionTtlSeconds`
- **Durability And Security:** `DynamoPointInTimeRecovery`, DynamoDB SSE enabled by default, table retain policy for replacement/deletion safety
- **Observability:** `LambdaLogRetentionDays`, `WebSocketAccessLogRetentionDays`, `EnableXRayTracing`

Recommended baseline profile for production:

- `PollingScheduleState=ENABLED`
- `DynamoPointInTimeRecovery=ENABLED`
- `EnableXRayTracing=ENABLED`
- `LambdaLogRetentionDays=14` (or longer for regulated workloads)

Recommended baseline profile for development:

- `PollingScheduleState=DISABLED` when using local mock streams
- Shorter log retention windows (for example `7`) to reduce costs

## References

1. [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/) - HTML5 Canvas charting library used in `AnalysisChart.tsx`
2. [TanStack Table v8](https://tanstack.com/table/v8) - Headless table engine used in `MetricsTable.tsx`
3. [vnstock3](https://github.com/thinh-vu/vnstock) - Python library for Vietnamese stock market data used in `app.py`
4. [Next.js App Router](https://nextjs.org/docs/app) - React framework powering the frontend
5. [AWS SAM Developer Guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) - SAM template and deployment toolchain
6. [Amazon API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html) - WebSocket connection lifecycle and route management
