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
  company_name?: string;
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

export interface StreamHistoryBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StreamPacket {
  dashboard_id: string;
  connection_id: string;
  as_of_epoch?: number;
  data: Record<string, DashboardTickerSnapshot>;
  history?: Record<string, StreamHistoryBar[]>;
  notifications?: NotificationEvent[];
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

export type TimerangeOption = '1D' | '1W' | '1M' | '3M';

export interface DashboardDefinition {
  id: string;
  name: string;
  description: string;
  indicatorId: string;
  symbols: string[];
}

export interface SymbolCatalogItem {
  symbol: string;
  companyName: string;
  exchange?: string;
}

export interface IndicatorDefinition {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  params: Record<string, number>;
}

export type NotificationMetricField = 'price' | 'mtf_score' | 'ls_ratio' | 'z_score' | 'trend_delta';
export type NotificationSignalField = 'mtf_signal' | 'ls_signal' | 'z_signal' | 'trend_signal';
export type NotificationComparator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ';
export type NotificationGroupOperator = 'AND' | 'OR';

export interface NotificationSignalCondition {
  type: 'signal';
  field: NotificationSignalField;
  signal: IndicatorSignal;
}

export interface NotificationMetricCondition {
  type: 'metric';
  field: NotificationMetricField;
  comparator: NotificationComparator;
  value: number;
}

export interface NotificationGroupCondition {
  type: 'group';
  operator: NotificationGroupOperator;
  conditions: NotificationCondition[];
}

export type NotificationCondition =
  | NotificationSignalCondition
  | NotificationMetricCondition
  | NotificationGroupCondition;

export interface NotificationChannelConfig {
  inApp: boolean;
  push: boolean;
}

export interface NotificationRule {
  id: string;
  name: string;
  dashboardId: string;
  symbol: string;
  indicatorId: string;
  condition: NotificationCondition;
  channels: NotificationChannelConfig;
  cooldownSeconds: number;
  enabled: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  lastTriggeredAtEpoch?: number;
}

export interface NotificationEvent {
  id: string;
  ruleId: string;
  dashboardId: string;
  symbol: string;
  message: string;
  triggeredAtEpoch: number;
  channels: NotificationChannelConfig;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAtEpoch: number;
  updatedAtEpoch: number;
}
