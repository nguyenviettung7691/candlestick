"use client";

import type { DashboardTickerSnapshot } from '@/lib/types';

type WatchlistRow = DashboardTickerSnapshot & {
  active_metric: string;
  active_signal: string;
  change?: number;
  change_pct?: number;
  updated_at_epoch?: number;
};

interface MetricsTableProps {
  rows: WatchlistRow[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  activeIndicatorLabel: string;
}

const decimal2Formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function signalTone(signal: string): string {
  const normalized = signal.toUpperCase();

  if (normalized.includes('BUY') || normalized.includes('BULLISH') || normalized.includes('ACCUMULATION')) {
    return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  }
  if (normalized.includes('SELL') || normalized.includes('BEARISH') || normalized.includes('DISTRIBUTION')) {
    return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  }
  return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
}

function metricTone(signal: string): string {
  const normalized = signal.toUpperCase();

  if (normalized.includes('BUY') || normalized.includes('BULLISH') || normalized.includes('ACCUMULATION')) {
    return 'text-emerald-300';
  }
  if (normalized.includes('SELL') || normalized.includes('BEARISH') || normalized.includes('DISTRIBUTION')) {
    return 'text-rose-300';
  }
  return 'text-slate-300';
}

function changeTone(change?: number): string {
  if (change === undefined || change === 0) {
    return 'text-slate-300';
  }
  return change > 0 ? 'text-emerald-300' : 'text-rose-300';
}

function formatTimeAgo(epochSeconds?: number): string {
  if (!epochSeconds) {
    return 'Awaiting packet';
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function MetricsTable({ rows, selectedSymbol, onSelectSymbol, activeIndicatorLabel }: MetricsTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[color:var(--panel)]/95 shadow-glow">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5 sm:py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Symbols Watchlist</h2>
        <p className="text-xs text-slate-500">Tap a row to focus chart</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/45 text-left text-[12px] text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Symbol</th>
              <th className="px-4 py-2.5 font-medium">Price</th>
              <th className="px-4 py-2.5 font-medium">Change</th>
              <th className="px-4 py-2.5 font-medium">Change %</th>
              <th className="px-4 py-2.5 font-medium">Score ({activeIndicatorLabel})</th>
              <th className="px-4 py-2.5 font-medium">Signal</th>
              <th className="px-4 py-2.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-slate-500" colSpan={7}>
                  Waiting for stream data.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={`${row.symbol}-${index}`}
                  className={[
                    'cursor-pointer transition-colors',
                    row.symbol === selectedSymbol
                      ? 'bg-cyan-500/10 hover:bg-cyan-500/15'
                      : 'bg-transparent hover:bg-slate-950/40',
                  ].join(' ')}
                  onClick={() => onSelectSymbol(row.symbol)}
                >
                  <td className="px-4 py-2.5 font-semibold text-slate-100">{row.symbol}</td>
                  <td className="px-4 py-2.5 text-slate-200">{decimal2Formatter.format(row.price)}</td>
                  <td className={["px-4 py-2.5", changeTone(row.change)].join(' ')}>
                    {row.change === undefined ? '--' : `${row.change >= 0 ? '+' : ''}${decimal2Formatter.format(row.change)}`}
                  </td>
                  <td className={["px-4 py-2.5", changeTone(row.change_pct)].join(' ')}>
                    {row.change_pct === undefined
                      ? '--'
                      : `${row.change_pct >= 0 ? '+' : ''}${decimal2Formatter.format(row.change_pct)}%`}
                  </td>
                  <td className={["px-4 py-2.5 font-medium", metricTone(row.active_signal)].join(' ')}>{row.active_metric}</td>
                  <td className="px-4 py-2.5 text-slate-300">
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${signalTone(row.active_signal)}`}>
                      {row.active_signal}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{formatTimeAgo(row.updated_at_epoch)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
