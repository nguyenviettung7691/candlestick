## **Project Overview & Objectives**

Build a fully serverless, scale-to-zero web application for the Candlestick indicator tracking dashboard. The architecture utilizes a "Hydrate-then-Stream" pattern via AWS Lambda execution loops, eliminating the need for an always-on server or load balancer.

### **Tech Stack Specifications**

* **Frontend:** Next.js 14+ (App Router, TypeScript), Tailwind CSS, TanStack Table v8, Lightweight Charts (TradingView HTML5 Canvas).  
* **Backend Runtime:** Python 3.11 (AWS Lambda optimized with NumPy/Pandas).  
* **Database & WebSocket Gateway:** Amazon DynamoDB (Single-Table Design), Amazon API Gateway (WebSocket API).  
* **Scheduling & Security:** Amazon EventBridge (Cron), AWS Secrets Manager (VAPID keys, sessions).

## **1\. Project Directory Structure**

Instruct the agent to generate the following file tree layout:

Plaintext  
├── backend/  
│   ├── lambda\_polling/  
│   │   ├── app.py                 \# Core Lambda loop (55-second execution)  
│   │   ├── indicators.py          \# Vectorized math engines (MTF, LS-DVP, MR-ZSB, ATRM)  
│   │   ├── requirements.txt       \# Dependencies: vnstock3, pandas, numpy, boto3  
│   ├── lambda\_websocket/  
│   │   ├── connection.py          \# Handles $connect, $disconnect, $default routes  
│   └── template.yaml              \# AWS SAM / CloudFormation Template  
└── frontend/  
    ├── src/  
    │   ├── app/  
    │   │   ├── layout.tsx  
    │   │   └── page.tsx           \# Dashboard layout container  
    │   ├── components/  
    │   │   ├── MetricsTable.tsx   \# TanStack Table list  
    │   │   └── AnalysisChart.tsx  \# TradingView Canvas Chart component  
    │   ├── hooks/  
    │   │   └── useWebSocket.ts    \# Reconnectable WS hook  
    │   └── lib/  
    │       └── types.ts           \# Shared TypeScript interfaces

  The Lambda folders are intentionally kept package-marker free; the handlers are loaded as top-level modules inside their own deployment bundles.

## **2\. Database Schema (DynamoDB Single-Table Specification)**

Create a single table named CandlestickDashboardTable with a Partition Key (PK, String) and Sort Key (SK, String). Enable Time to Live (TTL) on the attribute ttl for ephemeral items such as websocket connections.

Connection TTL values should be computed at write time as `connected_at_epoch + WS_CONNECTION_TTL_SECONDS`; do not hard-code a single absolute epoch for all connections.

JSON  
\[  
  {  
    "Description": "Active Connection Item",  
    "PK": "WS\_CONNECTION\#connectionId\_abc123",  
    "connected_at": 1785195600,
    "ttl": 1785199200
    "ttl": 1785199200  
  },  
  {  
    "Description": "User Dashboard Item",  
    "PK": "USER\#user\_99",  
    "SK": "DASH\#dash\_01",  
    "dashboard\_name": "Banking Sector Screen",  
    "indicator\_id": "MTF\_SCORING",  
    "custom\_params": "{\\"w\_1d\\": 0.2, \\"w\_1w\\": 0.3, \\"w\_1m\\": 0.5, \\"lookback\\": 14}"  

Notes:

- Persistent dashboard and user records should omit `ttl` so they are not deleted automatically.
- Connection records should keep the `SK` scoped to the dashboard because the poller and disconnect handler rely on that reverse lookup.
- If the connection lifetime changes, update `WS_CONNECTION_TTL_SECONDS` in the deployment environment rather than changing the schema.
  },  
  {  
    "Description": "Watchlist Symbol Mapping",  
    "PK": "DASH\#dash\_01",  
    "SK": "SYMBOL\#FPT",  
    "ticker\_code": "FPT",  
    "company\_name": "FPT Corporation"  
  }  
\]

## **3\. Core Backend Math Engine (backend/lambda\_polling/indicators.py)**

This file contains the high-performance vectorized implementations of the four default quantitative frameworks.

Python  
import numpy as np  
import pandas as pd

def calculate\_mtf\_scoring(df\_1d: pd.DataFrame, df\_1w: pd.DataFrame, df\_1m: pd.DataFrame, params: dict) \-\> dict:  
    """  
    Multi-Timeframe Scoring Framework  
    Formula: S\_MTF \= sum(w\_t \* ((C\_t \- L\_n,t) / (H\_n,t \- L\_n,t)) \* 100\)  
    """  
    w\_1d \= params.get('w\_1d', 0.2)  
    w\_1w \= params.get('w\_1w', 0.3)  
    w\_1m \= params.get('w\_1m', 0.5)  
    n \= params.get('lookback', 14)  
      
    def get\_tier\_score(df, lookback):  
        if len(df) \< lookback: return 50.0  
        close \= df\['close'\].iloc\[-1\]  
        low\_n \= df\['low'\].tail(lookback).min()  
        high\_n \= df\['high'\].tail(lookback).max()  
        if high\_n \== low\_n: return 50.0  
        return ((close \- low\_n) / (high\_n \- low\_n)) \* 100.0

    s\_1d \= get\_tier\_score(df\_1d, n)  
    s\_1w \= get\_tier\_score(df\_1w, n)  
    s\_1m \= get\_tier\_score(df\_1m, n)  
      
    final\_score \= (w\_1d \* s\_1d) \+ (w\_1w \* s\_1w) \+ (w\_1m \* s\_1m)  
    signal \= "BUY" if final\_score \> 75 else ("SELL" if final\_score \< 30 else "NEUTRAL")  
      
    return {"metric": round(final\_score, 2), "signal": signal}

def calculate\_ls\_dvp(df\_1d: pd.DataFrame, params: dict) \-\> dict:  
    """  
    Liquidity Shock & Delta Volume Profile  
    Tracks volume anomalies relative to 20-day MA alongside spread compression.  
    """  
    lookback \= params.get('volume\_ma', 20)  
    multiplier \= params.get('shock\_threshold', 2.0)  
    if len(df\_1d) \< lookback: return {"metric": 1.0, "signal": "NEUTRAL"}  
      
    current\_vol \= df\_1d\['volume'\].iloc\[-1\]  
    ma\_vol \= df\_1d\['volume'\].tail(lookback).mean()  
    vol\_ratio \= current\_vol / ma\_vol if ma\_vol \> 0 else 1.0  
      
    close \= df\_1d\['close'\].iloc\[-1\]  
    open\_p \= df\_1d\['open'\].iloc\[-1\]  
    spread \= abs(close \- open\_p)  
      
    signal \= "NEUTRAL"  
    if vol\_ratio \>= multiplier:  
        signal \= "SHOCK\_ACCUMULATION" if close \>= open\_p else "SHOCK\_DISTRIBUTION"  
          
    return {"metric": round(vol\_ratio, 2), "signal": signal}

def calculate\_mr\_zsb(df\_1d: pd.DataFrame, params: dict) \-\> dict:  
    """  
    Mean Reversion Z-Score Band  
    Measures standard deviations from the historical moving average.  
    """  
    period \= params.get('ma\_period', 50)  
    if len(df\_1d) \< period: return {"metric": 0.0, "signal": "NEUTRAL"}  
      
    df\_1d\['ma'\] \= df\_1d\['close'\].rolling(window=period).mean()  
    df\_1d\['std'\] \= df\_1d\['close'\].rolling(window=period).std()  
      
    current\_close \= df\_1d\['close'\].iloc\[-1\]  
    current\_ma \= df\_1d\['ma'\].iloc\[-1\]  
    current\_std \= df\_1d\['std'\].iloc\[-1\]  
      
    z\_score \= (current\_close \- current\_ma) / current\_std if current\_std \> 0 else 0.0  
    signal \= "BUY\_OVERSOLD" if z\_score \< \-2.0 else ("SELL\_OVERBOUGHT" if z\_score \> 2.0 else "NEUTRAL")  
      
    return {"metric": round(z\_score, 2), "signal": signal}

def calculate\_atrm(df\_1d: pd.DataFrame, params: dict) \-\> dict:  
    """  
    Adaptive Trend Regime Matrix  
    Calculates moving average trend tracking lines.  
    """  
    fast\_p \= params.get('fast\_ema', 12)  
    slow\_p \= params.get('slow\_ema', 26)  
    if len(df\_1d) \< slow\_p: return {"metric": 0.0, "signal": "NEUTRAL"}  
      
    fast\_ema \= df\_1d\['close'\].ewm(span=fast\_p, adjust=False).mean().iloc\[-1\]  
    slow\_ema \= df\_1d\['close'\].ewm(span=slow\_p, adjust=False).mean().iloc\[-1\]  
    delta \= fast\_ema \- slow\_ema  
      
    signal \= "BULLISH\_TREND" if delta \> 0 else "BEARISH\_TREND"  
    return {"metric": round(delta, 2), "signal": signal}

## **4\. Main Polling Function (backend/lambda\_polling/app.py)**

This file implements the execution loop that handles streaming events within the 60-second threshold block.

Python  
import os  
import time  
import asyncio  
import boto3  
import pandas as pd  
from vnstock3 import Vnstock  
from indicators import calculate\_mtf\_scoring, calculate\_ls\_dvp, calculate\_mr\_zsb, calculate\_atrm

dynamodb \= boto3.resource('dynamodb')  
table \= dynamodb.Table('CandlestickDashboardTable')

\# Setup API Gateway Management API Client  
apigw\_client \= boto3.client(  
    'apigatewaymanagementapi',  
    endpoint\_url=os.environ\['WEBSOCKET\_API\_ENDPOINT'\]  
)

def get\_active\_targets():  
    \# Scan for unique tickers mapped to open browser loops  
    response \= table.scan(  
        FilterExpression=boto3.dynamodb.conditions.Attr('PK').begins\_with('DASH\#') &   
                         boto3.dynamodb.conditions.Attr('SK').begins\_with('SYMBOL\#')  
    )  
    tickers \= list(set(\[item\['ticker\_code'\] for item in response.get('Items', \[\])\]))  
      
    connections\_resp \= table.scan(  
        FilterExpression=boto3.dynamodb.conditions.Attr('PK').begins\_with('WS\_CONNECTION\#')  
    )  
    connections \= connections\_resp.get('Items', \[\])  
    return tickers, connections

async def poll\_and\_broadcast():  
    start\_time \= time.time()  
    stock\_engine \= Vnstock()  
      
    while time.time() \- start\_time \< 52:  
        loop\_start \= time.time()  
        tickers, connections \= get\_active\_targets()  
          
        if not tickers or not connections:  
            await asyncio.sleep(10)  
            continue  
              
        \# Bulk extract live price fields using vnstock  
        try:  
            live\_data \= {}  
            for ticker in tickers:  
                \# Pull daily raw dataset matrices  
                stock\_data \= stock\_engine.stock(symbol=ticker, source='VCI')  
                df\_1d \= stock\_data.trading.history(period='1D', size=100)  
                  
                \# Mock weekly/monthly groupings for structural metrics framework  
                df\_1w \= df\_1d.resample('W', on='time').last() if 'time' in df\_1d.columns else df\_1d  
                df\_1m \= df\_1d.resample('M', on='time').last() if 'time' in df\_1d.columns else df\_1d  
                  
                live\_price \= float(df\_1d\['close'\].iloc\[-1\])  
                  
                \# Compute indicator profiles  
                mtf \= calculate\_mtf\_scoring(df\_1d, df\_1w, df\_1m, {})  
                ls\_dvp \= calculate\_ls\_dvp(df\_1d, {})  
                zsb \= calculate\_mr\_zsb(df\_1d, {})  
                atrm \= calculate\_atrm(df\_1d, {})  
                  
                live\_data\[ticker\] \= {  
                    "symbol": ticker,  
                    "price": live\_price,  
                    "mtf\_score": mtf\["metric"\],  
                    "mtf\_signal": mtf\["signal"\],  
                    "ls\_ratio": ls\_dvp\["metric"\],  
                    "ls\_signal": ls\_dvp\["signal"\],  
                    "z\_score": zsb\["metric"\],  
                    "z\_signal": zsb\["signal"\],  
                    "trend\_delta": atrm\["metric"\],  
                    "trend\_signal": atrm\["signal"\]  
                }  
        except Exception as e:  
            print(f"Data ingestion anomaly: {str(e)}")  
            await asyncio.sleep(5)  
            continue

        \# Broadcast mapped metrics payloads to live WebSocket connections  
        for conn in connections:  
            try:  
                conn\_id \= conn\['PK'\].split('\#')\[1\]  
                target\_dash \= conn\['SK'\].split('\#')\[1\]  
                  
                \# Filter down packet payload matrix data to match dashboard rules  
                apigw\_client.post\_to\_connection(  
                    ConnectionId=conn\_id,  
                    Data=pd.Series(live\_data).to\_json(orient='records')  
                )  
            except Exception:  
                \# Handle structural disconnects by pruning connection state pointers  
                table.delete\_item(Key={'PK': conn\['PK'\], 'SK': conn\['SK'\]})

        elapsed \= time.time() \- loop\_start  
        sleep\_duration \= max(10 \- elapsed, 1)  
        await asyncio.sleep(sleep\_duration)

def lambda\_handler(event, context):  
    asyncio.run(poll\_and\_broadcast())  
    return {"statusCode": 200, "body": "Cycle complete"}

## **5\. UI Layout Blueprint (frontend/src/components/AnalysisChart.tsx)**

This component structures the canvas charts and handles the overlay logic.

TypeScript  
"use client";  
import { useEffect, useRef } from 'react';  
import { createChart, IChartApi, ISeriesApi } from 'lightweight-charts';

interface ChartProps {  
  symbol: string;  
  historicalData: any\[\]; // Array of structural bar data: { time, open, high, low, close }  
  indicatorMarkers: any\[\]; // Array of alert points: { time, position, color, text }  
}

export default function AnalysisChart({ symbol, historicalData, indicatorMarkers }: ChartProps) {  
  const chartContainerRef \= useRef\<HTMLDivElement\>(null);  
  const chartRef \= useRef\<IChartApi | null\>(null);  
  const candlestickSeriesRef \= useRef\<ISeriesApi\<"Candlestick"\> | null\>(null);

  useEffect(() \=\> {  
    if (\!chartContainerRef.current) return;

    // Create high-performance HTML5 canvas instance layout  
    const chart \= createChart(chartContainerRef.current, {  
      width: chartContainerRef.current.clientWidth,  
      height: 400,  
      layout: { background: { value: '\#131722' }, textColor: '\#d1d4dc' },  
      grid: { vertLines: { color: '\#242832' }, horzLines: { color: '\#242832' } },  
    });

    const candlestickSeries \= chart.addCandlestickSeries({  
      upColor: '\#26a69a', downColor: '\#ef5350', borderVisible: false,  
      wickUpColor: '\#26a69a', wickDownColor: '\#ef5350',  
    });

    candlestickSeries.setData(historicalData);  
    candlestickSeries.setMarkers(indicatorMarkers);

    chartRef.current \= chart;  
    candlestickSeriesRef.current \= candlestickSeries;

    const handleResize \= () \=\> {  
      if (chartContainerRef.current && chartRef.current) {  
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });  
      }  
    };

    window.addEventListener('resize', handleResize);  
    return () \=\> {  
      window.removeEventListener('resize', handleResize);  
      chart.remove();  
    };  
  }, \[historicalData, indicatorMarkers\]);

  return (  
    \<div className="w-full bg-slate-900 p-4 rounded-xl shadow-lg border border-slate-800"\>  
      \<h3 className="text-lg font-bold text-slate-100 mb-2"\>Metrics Stream Visualization: {symbol}\</h3\>  
      \<div ref={chartContainerRef} className="w-full h-\[400px\]" /\>  
    \</div\>  
  );  
}

## **6\. Frontend Asset Notes**

The active scaffold does not currently include a service worker. Keep Web Push assets out of the tree until the registration path and notification pipeline are wired into the Next.js app.

## **7\. Execution Instructions for the Scaffolding Agent**

Instruct your coding agent to follow these setup steps to assemble and run the workspace:

1. **Create Regulatory Git Files:** Create suitable README.md file, .gitignore file, and LICENSE file.
2. **Scaffold Directory Structures:** Initialize the backend as a Python workspace and the frontend as a Next.js TypeScript boilerplate.  
3. **Inject Source Implementations:** Populate the provided python file templates into /backend and core visualization components into /frontend.  
4. **Configure Local Mock Testing Matrix:** Create a local development endpoint mapping script that simulates the incoming WebSocket stream from API Gateway to test the NextJS layout changes without running live cloud stacks.  
5. **Deploy AWS Infrastructure Blueprint:** Spin up dependencies via AWS SAM using sam deploy \--guided or apply the resource matrix mappings directly to the AWS Cloud Console UI within the respective service control centers.

### **7.1 Deployment Inputs & Hardening Controls (SAM)**

The SAM template should expose deployment parameters so environments can be tuned without code edits.

* **Naming & Routing:** `DashboardTableName`, `StageName`, `WebSocketApiName`, `WebSocketRouteSelectionExpression`
* **Polling Control Plane:** `PollingScheduleExpression`, `PollingScheduleState`, `PollIntervalSeconds`, `MaxRuntimeSeconds`, `PriceHistorySize`, `StockDataSource`
* **Function Sizing:** `FunctionTimeoutSeconds`, `FunctionMemorySize`
* **Connection Lifecycle:** `WebSocketConnectionTtlSeconds`
* **Durability & Security:** `DynamoPointInTimeRecovery`, DynamoDB SSE enabled by default, table retain policy for replacement/deletion safety
* **Observability:** `LambdaLogRetentionDays`, `WebSocketAccessLogRetentionDays`, `EnableXRayTracing`

Recommended baseline profile for production:

* `PollingScheduleState=ENABLED`
* `DynamoPointInTimeRecovery=ENABLED`
* `EnableXRayTracing=ENABLED`
* `LambdaLogRetentionDays=14` (or longer for regulated workloads)

Recommended baseline profile for development:

* `PollingScheduleState=DISABLED` when using local mock streams
* Shorter log retention windows (for example `7`) to reduce costs

**Source**  
1\. [https://github.com/Algo360-by-Odav/Algo360FX](https://github.com/Algo360-by-Odav/Algo360FX)