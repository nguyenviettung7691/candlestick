"use client";

import { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type SeriesMarker, type Time } from 'lightweight-charts';

import type { CandleBar, IndicatorMarker, TimerangeOption } from '@/lib/types';

interface ChartProps {
  symbol: string;
  companyName: string;
  timerange: TimerangeOption;
  onChangeTimerange: (timerange: TimerangeOption) => void;
  historicalData: CandleBar[];
  indicatorMarkers: IndicatorMarker[];
}

const TIMERANGE_OPTIONS: TimerangeOption[] = ['1D', '1W', '1M', '3M'];

export default function AnalysisChart({
  symbol,
  companyName,
  timerange,
  onChangeTimerange,
  historicalData,
  indicatorMarkers,
}: ChartProps) {
  const hasSelectedSymbol = symbol.trim().length > 0;
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

  const normalizedMarkers = useMemo<SeriesMarker<Time>[]>(() => {
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
  const lastCloseLabel = latestClose === undefined ? 'Pending' : latestClose.toFixed(2);
  const deltaClass =
    sessionDirection === 'up' ? 'text-emerald-400' : sessionDirection === 'down' ? 'text-rose-400' : 'text-slate-300';
  const deltaPctClass =
    sessionDirection === 'up' ? 'text-emerald-300/85' : sessionDirection === 'down' ? 'text-rose-300/85' : 'text-slate-400';

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

  useEffect(() => {
    if (!chartRef.current || normalizedHistory.length === 0) {
      return;
    }

    chartRef.current.timeScale().fitContent();
  }, [timerange, normalizedHistory.length]);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[color:var(--panel)]/95 shadow-glow">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5 sm:py-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Live Chart</h2>
          <p className="mt-1 flex min-w-0 items-center gap-x-2 leading-tight">
            <span className="shrink-0 text-2xl font-extrabold tracking-[0.05em] text-slate-100">
              {hasSelectedSymbol ? symbol : 'No symbol selected'}
            </span>
            <span className="max-w-[200px] truncate text-xs font-medium uppercase tracking-[0.16em] text-slate-500 sm:max-w-[300px]">
              {hasSelectedSymbol ? companyName : ''}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs tracking-[0.04em]">
            <span className={["text-sm font-semibold sm:text-base", deltaClass].join(' ')}>
              {sessionDelta === undefined ? 'No session delta' : `${sessionDelta >= 0 ? '+' : ''}${sessionDelta.toFixed(2)}`}
            </span>
            <span className={["font-medium", deltaPctClass].join(' ')}>
              {sessionDeltaPct === undefined ? 'Awaiting 2 bars' : `${sessionDeltaPct >= 0 ? '+' : ''}${sessionDeltaPct.toFixed(2)}%`}
            </span>
            <span className="text-slate-500">Last close: {lastCloseLabel}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-full border border-slate-700 bg-slate-950/45 p-1">
            {TIMERANGE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                disabled={!hasSelectedSymbol}
                onClick={() => onChangeTimerange(option)}
                className={[
                  'rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  option === timerange ? 'bg-cyan-400/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200',
                  !hasSelectedSymbol ? 'cursor-not-allowed opacity-45 hover:text-slate-400' : '',
                ].join(' ')}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="relative">
        <div ref={chartContainerRef} className="h-[360px] w-full sm:h-[420px]" />
        {!hasSelectedSymbol || normalizedHistory.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]">
            <p className="text-sm text-slate-400">
              {hasSelectedSymbol ? 'Waiting for chart history...' : 'Select a symbol from the watchlist to view chart'}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
