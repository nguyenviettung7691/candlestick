import type { Time } from 'lightweight-charts';

export type IndicatorSignal =
  | 'BUY'
  | 'SELL'
  | 'NEUTRAL'
  | 'SHOCK_ACCUMULATION'
  | 'SHOCK_DISTRIBUTION'
  | 'BUY_OVERSOLD'
  | 'SELL_OVERBOUGHT'
  | 'BULLISH_TREND'
  | 'BEARISH_TREND';

export interface IndicatorSnapshot {
  metric: number;
  signal: IndicatorSignal;
}

export interface DashboardTickerSnapshot {
  symbol: string;
  price: number;
  mtf_score: number;
  mtf_signal: IndicatorSignal;
  ls_ratio: number;
  ls_signal: IndicatorSignal;
  z_score: number;
  z_signal: IndicatorSignal;
  trend_delta: number;
  trend_signal: IndicatorSignal;
}

export interface StreamPacket {
  dashboard_id: string;
  connection_id: string;
  as_of_epoch?: number;
  data: Record<string, DashboardTickerSnapshot>;
}

export interface CandleBar {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndicatorMarker {
  time: Time;
  position: 'aboveBar' | 'belowBar';
  color: string;
  text: string;
}
