"use client";

import { useEffect, useMemo, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';

import AnalysisChart from '@/components/AnalysisChart';
import { MetricsTable } from '@/components/MetricsTable';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { CandleBar, DashboardTickerSnapshot, IndicatorMarker } from '@/lib/types';

const SAMPLE_HISTORY: CandleBar[] = [
  { time: 1782518400 as UTCTimestamp, open: 1284, high: 1290, low: 1278, close: 1288 },
  { time: 1782604800 as UTCTimestamp, open: 1288, high: 1294, low: 1282, close: 1291 },
  { time: 1782691200 as UTCTimestamp, open: 1291, high: 1301, low: 1289, close: 1298 },
  { time: 1782777600 as UTCTimestamp, open: 1298, high: 1302, low: 1290, close: 1294 },
  { time: 1782864000 as UTCTimestamp, open: 1294, high: 1306, low: 1292, close: 1304 },
];

const MAX_BARS_PER_SYMBOL = 120;

const SAMPLE_ROWS: DashboardTickerSnapshot[] = [
  {
    symbol: 'FPT',
    price: 128.25,
    mtf_score: 77.2,
    mtf_signal: 'BUY',
    ls_ratio: 2.14,
    ls_signal: 'SHOCK_ACCUMULATION',
    z_score: 1.28,
    z_signal: 'NEUTRAL',
    trend_delta: 0.82,
    trend_signal: 'BULLISH_TREND',
  },
];

function synthesizeCandle(prevClose: number, close: number, time: UTCTimestamp): CandleBar {
  const spread = Math.max(Math.abs(close - prevClose) * 0.6, close * 0.0015);
  return {
    time,
    open: Number(prevClose.toFixed(2)),
    high: Number((Math.max(prevClose, close) + spread).toFixed(2)),
    low: Number((Math.min(prevClose, close) - spread).toFixed(2)),
    close: Number(close.toFixed(2)),
  };
}

function buildSignalMarker(row: DashboardTickerSnapshot, time: UTCTimestamp): IndicatorMarker | null {
  if (row.trend_signal !== 'NEUTRAL') {
    return {
      time,
      position: row.trend_signal === 'BULLISH_TREND' ? 'belowBar' : 'aboveBar',
      color: row.trend_signal === 'BULLISH_TREND' ? '#34d399' : '#f87171',
      text: row.trend_signal,
    };
  }
  if (row.mtf_signal !== 'NEUTRAL') {
    return {
      time,
      position: row.mtf_signal === 'BUY' ? 'belowBar' : 'aboveBar',
      color: row.mtf_signal === 'BUY' ? '#34d399' : '#f87171',
      text: row.mtf_signal,
    };
  }
  if (row.z_signal !== 'NEUTRAL') {
    return {
      time,
      position: row.z_signal.includes('BUY') ? 'belowBar' : 'aboveBar',
      color: row.z_signal.includes('BUY') ? '#34d399' : '#f59e0b',
      text: row.z_signal,
    };
  }
  if (row.ls_signal !== 'NEUTRAL') {
    return {
      time,
      position: row.ls_signal.includes('ACCUMULATION') ? 'belowBar' : 'aboveBar',
      color: row.ls_signal.includes('ACCUMULATION') ? '#34d399' : '#f59e0b',
      text: row.ls_signal,
    };
  }
  return null;
}

export default function Page() {
  const dashboardId = process.env.NEXT_PUBLIC_DASHBOARD_ID ?? 'dash_01';

  const { connected, connectionState, lastPacket, error } = useWebSocket({
    url: process.env.NEXT_PUBLIC_WEBSOCKET_URL ?? 'ws://localhost:8787',
    dashboardId,
  });

  const [historyBySymbol, setHistoryBySymbol] = useState<Record<string, CandleBar[]>>({
    FPT: SAMPLE_HISTORY,
  });
  const [selectedSymbol, setSelectedSymbol] = useState<string>('FPT');

  const liveRows = useMemo(() => Object.values(lastPacket?.data ?? {}), [lastPacket]);
  const rows = liveRows.length > 0 ? liveRows : SAMPLE_ROWS;

  useEffect(() => {
    if (!lastPacket || liveRows.length === 0) {
      return;
    }

    const time = (lastPacket.as_of_epoch ?? Math.floor(Date.now() / 1000)) as UTCTimestamp;

    setHistoryBySymbol((prev) => {
      const next: Record<string, CandleBar[]> = { ...prev };

      for (const row of liveRows) {
        const currentSeries = next[row.symbol] ?? [];
        const prevClose = currentSeries.at(-1)?.close ?? row.price;
        const newBar = synthesizeCandle(prevClose, row.price, time);
        const withNewBar =
          currentSeries.length > 0 && currentSeries[currentSeries.length - 1]?.time === time
            ? [...currentSeries.slice(0, -1), newBar]
            : [...currentSeries, newBar];

        next[row.symbol] = withNewBar.slice(-MAX_BARS_PER_SYMBOL);
      }

      return next;
    });

    if (!liveRows.some((row) => row.symbol === selectedSymbol)) {
      setSelectedSymbol(liveRows[0]?.symbol ?? 'VNINDEX');
    }
  }, [lastPacket, liveRows, selectedSymbol]);

  const selectedRow = rows.find((row) => row.symbol === selectedSymbol) ?? rows[0] ?? null;
  const selectedHistory = useMemo(() => historyBySymbol[selectedSymbol] ?? [], [historyBySymbol, selectedSymbol]);
  const chartMarkers = useMemo(() => {
    if (!selectedRow || selectedHistory.length === 0) {
      return [];
    }

    const marker = buildSignalMarker(selectedRow, selectedHistory[selectedHistory.length - 1].time as UTCTimestamp);
    return marker ? [marker] : [];
  }, [selectedRow, selectedHistory]);

  const streamLabel =
    connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting';

  return (
    <main className="min-h-screen px-4 py-8 text-slate-100 sm:px-6 lg:px-10">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="rounded-3xl border border-slate-800 bg-[color:var(--panel)] px-6 py-5 shadow-glow">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-slate-500">Hydrate-then-Stream</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-50 sm:text-4xl">VNINDEX Indicator Tracking Dashboard</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                A serverless analytics surface for market structure, liquidity shock detection, mean reversion, and trend regime monitoring.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-950/40 px-4 py-3 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-6">
                <span>Stream</span>
                <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>{streamLabel}</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">{error ?? 'Awaiting dashboard packets'}</div>
            </div>
          </div>
        </header>

        {rows.length > 0 ? (
          <section className="flex flex-wrap gap-2">
            {rows.map((row) => {
              const isActive = row.symbol === selectedSymbol;
              return (
                <button
                  key={row.symbol}
                  type="button"
                  onClick={() => setSelectedSymbol(row.symbol)}
                  className={[
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-200'
                      : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-500',
                  ].join(' ')}
                >
                  {row.symbol}
                </button>
              );
            })}
          </section>
        ) : null}

        <AnalysisChart symbol={selectedSymbol} historicalData={selectedHistory} indicatorMarkers={chartMarkers} />
        <MetricsTable rows={rows} />
      </div>
    </main>
  );
}
