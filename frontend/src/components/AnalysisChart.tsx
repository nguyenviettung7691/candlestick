"use client";

import { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type SeriesMarker } from 'lightweight-charts';

import type { CandleBar, IndicatorMarker } from '@/lib/types';

interface ChartProps {
  symbol: string;
  historicalData: CandleBar[];
  indicatorMarkers: IndicatorMarker[];
}

export default function AnalysisChart({ symbol, historicalData, indicatorMarkers }: ChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const hasAutoFittedRef = useRef(false);
  const previousSymbolRef = useRef(symbol);

  const normalizedHistory = useMemo<CandleBar[]>(() => {
    const sorted = [...historicalData].sort((left, right) => Number(left.time) - Number(right.time));
    const deduped: CandleBar[] = [];

    for (const bar of sorted) {
      if (deduped.length > 0 && deduped[deduped.length - 1].time === bar.time) {
        deduped[deduped.length - 1] = bar;
      } else {
        deduped.push(bar);
      }
    }

    return deduped;
  }, [historicalData]);

  const normalizedMarkers = useMemo<SeriesMarker<string>[]>(() => {
    const availableTimes = new Set(normalizedHistory.map((bar) => String(bar.time)));
    return indicatorMarkers
      .filter((marker) => availableTimes.has(String(marker.time)))
      .map((marker) => ({
      ...marker,
      shape: marker.position === 'aboveBar' ? 'arrowDown' : 'arrowUp',
    }));
  }, [indicatorMarkers, normalizedHistory]);
  const latestClose = normalizedHistory.at(-1)?.close;
  const previousClose = normalizedHistory.at(-2)?.close;
  const sessionDelta = latestClose !== undefined && previousClose !== undefined ? latestClose - previousClose : undefined;
  const sessionDeltaPct =
    sessionDelta !== undefined && previousClose && previousClose !== 0 ? (sessionDelta / previousClose) * 100 : undefined;
  const sessionDirection = sessionDelta === undefined ? 'flat' : sessionDelta > 0 ? 'up' : sessionDelta < 0 ? 'down' : 'flat';

  useEffect(() => {
    if (!chartContainerRef.current) {
      return;
    }

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 420,
      layout: {
        background: { color: '#08111f' },
        textColor: '#d1d5db',
      },
      grid: {
        vertLines: { color: '#172338' },
        horzLines: { color: '#172338' },
      },
      rightPriceScale: {
        borderColor: '#172338',
      },
      timeScale: {
        borderColor: '#172338',
        timeVisible: true,
      },
      crosshair: {
        vertLine: { color: '#375174', labelBackgroundColor: '#0f172a' },
        horzLine: { color: '#375174', labelBackgroundColor: '#0f172a' },
      },
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#34d399',
      downColor: '#f87171',
      borderVisible: false,
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
      priceLineVisible: true,
    });

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestickSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && chartRef.current) {
        chartRef.current.applyOptions({ width: Math.floor(width) });
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
      hasAutoFittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!candlestickSeriesRef.current || !chartRef.current) {
      return;
    }

    if (previousSymbolRef.current !== symbol) {
      previousSymbolRef.current = symbol;
      hasAutoFittedRef.current = false;
    }

    candlestickSeriesRef.current?.setData(normalizedHistory);
    candlestickSeriesRef.current?.setMarkers(normalizedMarkers);

    if (normalizedHistory.length > 0 && !hasAutoFittedRef.current) {
      chartRef.current.timeScale().fitContent();
      hasAutoFittedRef.current = true;
    }
  }, [normalizedHistory, normalizedMarkers, symbol]);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[color:var(--panel)] shadow-glow">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-400">Live Structure</h2>
          <p className="mt-1 text-lg font-semibold text-slate-100">{symbol}</p>
        </div>
        <div className="text-right">
          <div
            className={[
              'text-sm font-semibold',
              sessionDirection === 'up'
                ? 'text-emerald-400'
                : sessionDirection === 'down'
                  ? 'text-rose-400'
                  : 'text-slate-300',
            ].join(' ')}
          >
            {sessionDelta === undefined ? 'No session delta' : `${sessionDelta >= 0 ? '+' : ''}${sessionDelta.toFixed(2)}`}
          </div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
            {sessionDeltaPct === undefined ? 'Lightweight Charts' : `${sessionDeltaPct >= 0 ? '+' : ''}${sessionDeltaPct.toFixed(2)}%`}
          </div>
        </div>
      </div>
      <div className="relative">
        <div ref={chartContainerRef} className="h-[360px] w-full sm:h-[420px]" />
        {normalizedHistory.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]">
            <p className="text-sm text-slate-400">Waiting for chart history...</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
