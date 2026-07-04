"use client";

import type { DashboardTickerSnapshot } from '@/lib/types';

interface MetricsTableProps {
  rows: DashboardTickerSnapshot[];
}

const decimal2Formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const decimal1Formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
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

export function MetricsTable({ rows }: MetricsTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[color:var(--panel)] shadow-glow">
      <div className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-400">Indicator Matrix</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[720px] divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/40 text-left text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">MTF</th>
              <th className="px-4 py-3 font-medium">LS-DVP</th>
              <th className="px-4 py-3 font-medium">Z-Score</th>
              <th className="px-4 py-3 font-medium">ATRM</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  Waiting for stream data.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={`${row.symbol}-${index}`} className="bg-transparent transition-colors hover:bg-slate-950/40">
                  <td className="px-4 py-3 font-semibold text-slate-100">{row.symbol}</td>
                  <td className="px-4 py-3 text-slate-200">{decimal2Formatter.format(row.price)}</td>
                  <td className="px-4 py-3 text-slate-300">
                    <span>{decimal1Formatter.format(row.mtf_score)}</span>{' '}
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${signalTone(row.mtf_signal)}`}>
                      {row.mtf_signal}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    <span>{decimal2Formatter.format(row.ls_ratio)}</span>{' '}
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${signalTone(row.ls_signal)}`}>
                      {row.ls_signal}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    <span>{decimal2Formatter.format(row.z_score)}</span>{' '}
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${signalTone(row.z_signal)}`}>
                      {row.z_signal}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    <span>{decimal2Formatter.format(row.trend_delta)}</span>{' '}
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${signalTone(row.trend_signal)}`}>
                      {row.trend_signal}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
