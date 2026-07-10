"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';

import AnalysisChart from '@/components/AnalysisChart';
import { MetricsTable } from '@/components/MetricsTable';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getSymbolCatalog, saveSymbolCatalog } from '@/lib/local-db';
import type {
  CandleBar,
  DashboardDefinition,
  DashboardTickerSnapshot,
  IndicatorDefinition,
  IndicatorMarker,
  IndicatorSignal,
  NotificationEvent,
  NotificationCondition,
  NotificationRule,
  SymbolCatalogItem,
  TimerangeOption,
} from '@/lib/types';

const SYMBOL_COMPANY_NAMES: Record<string, string> = {
  FPT: 'FPT Corporation',
  HPG: 'Hoa Phat Group',
  VCB: 'Joint Stock Commercial Bank for Foreign Trade of Vietnam',
};

const BUILT_IN_INDICATORS: IndicatorDefinition[] = [
  {
    id: 'MTF_SCORING',
    name: 'MTF Scoring',
    description: 'Weighted multi-timeframe momentum confidence score.',
    isBuiltIn: true,
    params: { w_1d: 0.2, w_1w: 0.3, w_1m: 0.5, lookback: 14 },
  },
  {
    id: 'LS_DVP',
    name: 'LS-DVP',
    description: 'Liquidity shock ratio and distribution profile detector.',
    isBuiltIn: true,
    params: { volume_ma: 20, shock_threshold: 2 },
  },
  {
    id: 'MR_ZSB',
    name: 'MR-ZSB',
    description: 'Mean reversion z-score band framework.',
    isBuiltIn: true,
    params: { ma_period: 50 },
  },
  {
    id: 'ATRM',
    name: 'ATRM',
    description: 'Adaptive trend regime matrix using fast and slow EMA.',
    isBuiltIn: true,
    params: { fast_ema: 12, slow_ema: 26 },
  },
];

const INITIAL_DASHBOARDS: DashboardDefinition[] = [
  {
    id: 'dash_01',
    name: 'Core Dashboard',
    description: 'General market lens across key symbols.',
    indicatorId: 'MTF_SCORING',
    symbols: ['FPT', 'HPG', 'VCB'],
  },
  {
    id: 'banking',
    name: 'Banking Focus',
    description: 'Focused on banking and high-liquidity names.',
    indicatorId: 'LS_DVP',
    symbols: ['VCB', 'FPT'],
  },
  {
    id: 'steel',
    name: 'Steel Watch',
    description: 'Trend and mean-reversion watch for steel sector.',
    indicatorId: 'ATRM',
    symbols: ['HPG'],
  },
];

const SAMPLE_ROWS: DashboardTickerSnapshot[] = [
  {
    symbol: 'FPT',
    company_name: SYMBOL_COMPANY_NAMES.FPT,
    price: 163.24,
    mtf_score: 65.2,
    mtf_signal: 'NEUTRAL',
    ls_ratio: 4,
    ls_signal: 'SHOCK_DISTRIBUTION',
    z_score: -1.56,
    z_signal: 'NEUTRAL',
    trend_delta: -3.96,
    trend_signal: 'NEUTRAL',
  },
  {
    symbol: 'HPG',
    company_name: SYMBOL_COMPANY_NAMES.HPG,
    price: 25.79,
    mtf_score: 55.9,
    mtf_signal: 'NEUTRAL',
    ls_ratio: 4,
    ls_signal: 'SHOCK_DISTRIBUTION',
    z_score: -0.9,
    z_signal: 'NEUTRAL',
    trend_delta: -15.08,
    trend_signal: 'BEARISH_TREND',
  },
  {
    symbol: 'VCB',
    company_name: SYMBOL_COMPANY_NAMES.VCB,
    price: 162.88,
    mtf_score: 91.7,
    mtf_signal: 'BUY',
    ls_ratio: 4,
    ls_signal: 'SHOCK_DISTRIBUTION',
    z_score: 4.25,
    z_signal: 'SELL_OVERBOUGHT',
    trend_delta: 39.53,
    trend_signal: 'BULLISH_TREND',
  },
];

const DEFAULT_SYMBOL_CATALOG: SymbolCatalogItem[] = [
  { symbol: 'FPT', companyName: SYMBOL_COMPANY_NAMES.FPT, exchange: 'HOSE' },
  { symbol: 'HPG', companyName: SYMBOL_COMPANY_NAMES.HPG, exchange: 'HOSE' },
  { symbol: 'VCB', companyName: SYMBOL_COMPANY_NAMES.VCB, exchange: 'HOSE' },
];

const MAX_BARS_PER_SYMBOL = 180;
const TIMERANGE_TO_BARS: Record<TimerangeOption, number> = {
  '1D': 24,
  '1W': 60,
  '1M': 120,
  '3M': 180,
};
const ENABLE_LOCAL_FALLBACK = process.env.NEXT_PUBLIC_ENABLE_LOCAL_FALLBACK === 'true';

interface DashboardFormState {
  name: string;
  description: string;
  indicatorId: string;
  symbols: string[];
}

interface IndicatorEditorState {
  id: string;
  name: string;
  description: string;
  params: Record<string, string>;
}

interface NotificationFormState {
  id?: string;
  name: string;
  dashboardId: string;
  symbol: string;
  indicatorId: string;
  cooldownSeconds: string;
  enabled: boolean;
  channelsInApp: boolean;
  channelsPush: boolean;
  conditionJson: string;
}

interface ActiveIndicatorSnapshot {
  metric: number;
  signal: IndicatorSignal;
}

interface WatchlistRow extends DashboardTickerSnapshot {
  active_metric: string;
  active_signal: IndicatorSignal;
  change?: number;
  change_pct?: number;
  updated_at_epoch?: number;
}

function getDashboardSymbols(dashboards: DashboardDefinition[], dashboardId: string): string[] {
  const selectedDashboard = dashboards.find((dashboard) => dashboard.id === dashboardId);
  return normalizeSymbolList(selectedDashboard?.symbols ?? []);
}

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

function getActiveIndicatorSnapshot(indicatorId: string | undefined, row: DashboardTickerSnapshot): ActiveIndicatorSnapshot {
  switch (indicatorId) {
    case 'LS_DVP':
      return { metric: row.ls_ratio, signal: row.ls_signal };
    case 'MR_ZSB':
      return { metric: row.z_score, signal: row.z_signal };
    case 'ATRM':
      return { metric: row.trend_delta, signal: row.trend_signal };
    case 'MTF_SCORING':
    default:
      return { metric: row.mtf_score, signal: row.mtf_signal };
  }
}

function buildSignalMarker(row: DashboardTickerSnapshot, indicatorId: string | undefined, time: UTCTimestamp): IndicatorMarker | null {
  const active = getActiveIndicatorSnapshot(indicatorId, row);
  if (active.signal === 'NEUTRAL') {
    return null;
  }

  const bullishSignal =
    active.signal.includes('BUY') || active.signal.includes('BULLISH') || active.signal.includes('ACCUMULATION');

  return {
    time,
    position: bullishSignal ? 'belowBar' : 'aboveBar',
    color: bullishSignal ? '#34d399' : '#f87171',
    text: active.signal,
  };
}

function formatIndicatorMetric(indicatorId: string | undefined, metric: number): string {
  const digits = indicatorId === 'MTF_SCORING' ? 1 : 2;
  return metric.toFixed(digits);
}

function getSymbolChange(series: CandleBar[]): { delta: number; deltaPct: number } | null {
  const latest = series.at(-1)?.close;
  const previous = series.at(-2)?.close;
  if (latest === undefined || previous === undefined || previous === 0) {
    return null;
  }

  const delta = latest - previous;
  return {
    delta,
    deltaPct: (delta / previous) * 100,
  };
}

function toWatchlistRow(
  row: DashboardTickerSnapshot,
  activeIndicatorId: string | undefined,
  symbolHistory: CandleBar[],
  asOfEpoch?: number,
): WatchlistRow {
  const active = getActiveIndicatorSnapshot(activeIndicatorId, row);
  const change = getSymbolChange(symbolHistory);

  return {
    ...row,
    active_metric: formatIndicatorMetric(activeIndicatorId, active.metric),
    active_signal: active.signal,
    change: change?.delta,
    change_pct: change?.deltaPct,
    updated_at_epoch: asOfEpoch,
  };
}

function normalizeSymbolList(symbols: string[]): string[] {
  return Array.from(
    new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0),
    ),
  );
}

function mergeSymbolCatalog(baseCatalog: SymbolCatalogItem[], dashboards: DashboardDefinition[]): SymbolCatalogItem[] {
  const merged = new Map<string, SymbolCatalogItem>();

  for (const item of DEFAULT_SYMBOL_CATALOG) {
    merged.set(item.symbol, item);
  }

  for (const item of baseCatalog) {
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) {
      continue;
    }

    merged.set(symbol, {
      symbol,
      companyName: item.companyName?.trim() || SYMBOL_COMPANY_NAMES[symbol] || symbol,
      exchange: item.exchange,
    });
  }

  for (const dashboard of dashboards) {
    for (const symbol of dashboard.symbols) {
      const normalized = String(symbol).trim().toUpperCase();
      if (!normalized || merged.has(normalized)) {
        continue;
      }

      merged.set(normalized, {
        symbol: normalized,
        companyName: SYMBOL_COMPANY_NAMES[normalized] || normalized,
      });
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function toIndicatorEditorState(indicator: IndicatorDefinition): IndicatorEditorState {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(indicator.params)) {
    params[key] = String(value);
  }

  return {
    id: indicator.id,
    name: indicator.name,
    description: indicator.description,
    params,
  };
}

function defaultNotificationCondition(): NotificationCondition {
  return {
    type: 'metric',
    field: 'price',
    comparator: 'GTE',
    value: 100,
  };
}

function toNotificationFormState(rule: NotificationRule | null, dashboards: DashboardDefinition[]): NotificationFormState {
  const fallbackDashboard = dashboards[0];

  if (rule) {
    const dashboard = dashboards.find((entry) => entry.id === rule.dashboardId) ?? fallbackDashboard;
    const dashboardId = dashboard?.id ?? rule.dashboardId;
    const dashboardSymbols = normalizeSymbolList(dashboard?.symbols ?? []);
    const normalizedRuleSymbol = rule.symbol.trim().toUpperCase();
    const fallbackSymbol = dashboardSymbols[0] ?? (normalizedRuleSymbol || 'FPT');
    const symbol = dashboardSymbols.includes(normalizedRuleSymbol)
      ? normalizedRuleSymbol
      : fallbackSymbol;

    return {
      id: rule.id,
      name: rule.name,
      dashboardId,
      symbol,
      indicatorId: rule.indicatorId,
      cooldownSeconds: String(rule.cooldownSeconds),
      enabled: rule.enabled,
      channelsInApp: rule.channels.inApp,
      channelsPush: rule.channels.push,
      conditionJson: JSON.stringify(rule.condition, null, 2),
    };
  }

  const dashboard = fallbackDashboard;
  const dashboardSymbols = normalizeSymbolList(dashboard?.symbols ?? []);
  return {
    name: '',
    dashboardId: dashboard?.id ?? '',
    symbol: dashboardSymbols[0] ?? 'FPT',
    indicatorId: dashboard?.indicatorId ?? BUILT_IN_INDICATORS[0].id,
    cooldownSeconds: '300',
    enabled: true,
    channelsInApp: true,
    channelsPush: true,
    conditionJson: JSON.stringify(defaultNotificationCondition(), null, 2),
  };
}

function parseNotificationCondition(value: string): NotificationCondition | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const condition = parsed as Record<string, unknown>;
    if (condition.type === 'signal') {
      if (typeof condition.field !== 'string' || typeof condition.signal !== 'string') {
        return null;
      }
      return parsed as NotificationCondition;
    }
    if (condition.type === 'metric') {
      if (
        typeof condition.field !== 'string' ||
        typeof condition.comparator !== 'string' ||
        typeof condition.value !== 'number'
      ) {
        return null;
      }
      return parsed as NotificationCondition;
    }
    if (condition.type === 'group') {
      if (typeof condition.operator !== 'string' || !Array.isArray(condition.conditions)) {
        return null;
      }
      return parsed as NotificationCondition;
    }
    return null;
  } catch {
    return null;
  }
}

function formatNotificationTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

interface ApiListResponse<T> {
  ok: boolean;
  message?: string;
  items?: T[];
  item?: T;
}

interface SymbolCatalogResponse extends ApiListResponse<SymbolCatalogItem> {
  source?: 'provider' | 'vnstock' | 'fallback';
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
  });

  const payload = (await response.json()) as ApiListResponse<unknown>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message ?? `Request to ${path} failed`);
  }

  return payload as T;
}

export default function Page() {
  const [dashboards, setDashboards] = useState<DashboardDefinition[]>(ENABLE_LOCAL_FALLBACK ? INITIAL_DASHBOARDS : []);
  const [indicators, setIndicators] = useState<IndicatorDefinition[]>(BUILT_IN_INDICATORS);

  const [selectedDashboardId, setSelectedDashboardId] = useState<string>(
    ENABLE_LOCAL_FALLBACK ? INITIAL_DASHBOARDS[0].id : '',
  );
  const [selectedSymbol, setSelectedSymbol] = useState<string>('');
  const [timerange, setTimerange] = useState<TimerangeOption>('1W');
  const [configError, setConfigError] = useState<string | null>(null);
  const [isPersisting, setIsPersisting] = useState(false);

  const [isDashboardModalOpen, setIsDashboardModalOpen] = useState(false);
  const [isEditingDashboard, setIsEditingDashboard] = useState(false);
  const [dashboardForm, setDashboardForm] = useState<DashboardFormState>({
    name: '',
    description: '',
    indicatorId: BUILT_IN_INDICATORS[0].id,
    symbols: ['FPT', 'HPG', 'VCB'],
  });
  const [symbolCatalog, setSymbolCatalog] = useState<SymbolCatalogItem[]>(DEFAULT_SYMBOL_CATALOG);
  const [symbolCatalogError, setSymbolCatalogError] = useState<string | null>(null);
  const [symbolCatalogLoading, setSymbolCatalogLoading] = useState(false);
  const [isBackgroundFetching, setIsBackgroundFetching] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState('');

  const [isIndicatorModalOpen, setIsIndicatorModalOpen] = useState(false);
  const [activeIndicatorEditorId, setActiveIndicatorEditorId] = useState<string>(BUILT_IN_INDICATORS[0].id);
  const [indicatorEditor, setIndicatorEditor] = useState<IndicatorEditorState>(
    toIndicatorEditorState(BUILT_IN_INDICATORS[0]),
  );
  const [notificationRules, setNotificationRules] = useState<NotificationRule[]>([]);
  const [isNotificationModalOpen, setIsNotificationModalOpen] = useState(false);
  const [notificationForm, setNotificationForm] = useState<NotificationFormState>(
    toNotificationFormState(null, ENABLE_LOCAL_FALLBACK ? INITIAL_DASHBOARDS : []),
  );
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [liveNotificationEvents, setLiveNotificationEvents] = useState<NotificationEvent[]>([]);

  const dashboardId = selectedDashboardId || 'default';
  const { connected, connectionState, lastPacket, error } = useWebSocket({
    url: process.env.NEXT_PUBLIC_WEBSOCKET_URL ?? 'ws://localhost:8787',
    dashboardId,
  });

  const [historyBySymbol, setHistoryBySymbol] = useState<Record<string, CandleBar[]>>({});

  const activeDashboard = dashboards.find((dashboard) => dashboard.id === selectedDashboardId) ?? dashboards[0];
  const activeIndicator = indicators.find((indicator) => indicator.id === activeDashboard?.indicatorId) ?? indicators[0];
  const effectiveSymbolCatalog = useMemo(() => mergeSymbolCatalog(symbolCatalog, dashboards), [dashboards, symbolCatalog]);
  const filteredSymbolCatalog = useMemo(() => {
    const query = symbolSearch.trim().toLowerCase();
    if (!query) {
      return effectiveSymbolCatalog;
    }

    return effectiveSymbolCatalog.filter((item) => {
      const matchSymbol = item.symbol.toLowerCase().includes(query);
      const matchCompany = item.companyName.toLowerCase().includes(query);
      const matchExchange = item.exchange?.toLowerCase().includes(query) ?? false;
      return matchSymbol || matchCompany || matchExchange;
    });
  }, [effectiveSymbolCatalog, symbolSearch]);
  const notificationSymbolOptions = useMemo(() => {
    const dashboardSymbols = getDashboardSymbols(dashboards, notificationForm.dashboardId);
    const symbolMeta = new Map(effectiveSymbolCatalog.map((entry) => [entry.symbol, entry]));

    return dashboardSymbols.map((symbol) => ({
      symbol,
      companyName: symbolMeta.get(symbol)?.companyName ?? SYMBOL_COMPANY_NAMES[symbol] ?? symbol,
    }));
  }, [dashboards, effectiveSymbolCatalog, notificationForm.dashboardId]);

  const refreshSymbolCatalog = useCallback(async (isBackground = false): Promise<SymbolCatalogResponse | null> => {
    if (!isBackground) {
      setSymbolCatalogLoading(true);
    } else {
      setIsBackgroundFetching(true);
    }

    try {
      const response = await requestJson<SymbolCatalogResponse>('/api/symbols');
      const items = response.items ?? [];
      if (items.length > 0) {
        setSymbolCatalog(items);
        saveSymbolCatalog(items);
      }

      if (response.source === 'fallback') {
        setSymbolCatalogError('Showing fallback symbols. Loading full VNStock catalog may take a moment.');
      } else {
        setSymbolCatalogError(null);
      }

      return response;
    } catch {
      setSymbolCatalogError('Live symbol catalog is unavailable. Using fallback symbols.');
      return null;
    } finally {
      setSymbolCatalogLoading(false);
      setIsBackgroundFetching(false);
    }
  }, []);

  const hydrateConfiguration = useCallback(async () => {
    setConfigError(null);
    try {
      await requestJson<{ ok: true; user_id: string }>('/api/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const cachedCatalog = getSymbolCatalog();
      const hasCache = !!(cachedCatalog && cachedCatalog.length > 0);
      if (hasCache) {
        setSymbolCatalog(cachedCatalog!);
      }

      const symbolResponsePromise = hasCache 
        ? refreshSymbolCatalog(true) 
        : refreshSymbolCatalog(false);

      const [dashboardResponse, indicatorResponse, notificationResponse, symbolResponse] = await Promise.all([
        requestJson<ApiListResponse<DashboardDefinition>>('/api/dashboards'),
        requestJson<ApiListResponse<IndicatorDefinition>>('/api/indicators'),
        requestJson<ApiListResponse<NotificationRule>>('/api/notifications'),
        symbolResponsePromise,
      ]);

      const apiDashboards = dashboardResponse.items ?? [];
      const customIndicators = indicatorResponse.items ?? [];
      const notificationItems = notificationResponse.items ?? [];
      const mergedIndicators = [...BUILT_IN_INDICATORS, ...customIndicators];

      setIndicators(mergedIndicators);
      setDashboards(apiDashboards.length > 0 ? apiDashboards : ENABLE_LOCAL_FALLBACK ? INITIAL_DASHBOARDS : []);
      setNotificationRules(notificationItems);
      
      if (!hasCache && (!symbolResponse?.items?.length)) {
        setSymbolCatalog(DEFAULT_SYMBOL_CATALOG);
      }

      setSelectedDashboardId((prev) => {
        if (prev && apiDashboards.some((dashboard) => dashboard.id === prev)) {
          return prev;
        }
        if (apiDashboards.length > 0) {
          return apiDashboards[0].id;
        }
        if (ENABLE_LOCAL_FALLBACK) {
          return INITIAL_DASHBOARDS[0].id;
        }
        return '';
      });
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to load dashboard configuration.');
      if (ENABLE_LOCAL_FALLBACK) {
        setDashboards(INITIAL_DASHBOARDS);
      }
      setSymbolCatalog(DEFAULT_SYMBOL_CATALOG);
      setIndicators(BUILT_IN_INDICATORS);
      setNotificationRules([]);
    }
  }, [refreshSymbolCatalog]);

  useEffect(() => {
    void hydrateConfiguration();
  }, [hydrateConfiguration]);

  const liveRows = useMemo(() => Object.values(lastPacket?.data ?? {}), [lastPacket]);
  const livePacketNotifications = useMemo(() => lastPacket?.notifications ?? [], [lastPacket]);
  const rows = useMemo(() => {
    const sourceRows = liveRows.length > 0 ? liveRows : ENABLE_LOCAL_FALLBACK ? SAMPLE_ROWS : [];
    return sourceRows.map((row) => ({
      ...row,
      company_name: row.company_name ?? SYMBOL_COMPANY_NAMES[row.symbol] ?? row.symbol,
    }));
  }, [liveRows]);

  const availableSymbols = useMemo(() => {
    if (!activeDashboard) {
      return rows.map((row) => row.symbol);
    }

    const rowSymbols = new Set(rows.map((row) => row.symbol));
    return activeDashboard.symbols.filter((symbol) => rowSymbols.has(symbol));
  }, [activeDashboard, rows]);

  useEffect(() => {
    setLiveNotificationEvents([]);
  }, [dashboardId]);

  useEffect(() => {
    if (!lastPacket || liveRows.length === 0) {
      return;
    }

    const time = (lastPacket.as_of_epoch ?? Math.floor(Date.now() / 1000)) as UTCTimestamp;
    const historyByPacket = lastPacket.history ?? {};

    setHistoryBySymbol((prev) => {
      const next: Record<string, CandleBar[]> = { ...prev };

      for (const row of liveRows) {
        const incomingHistory = (historyByPacket[row.symbol] ?? []).map((bar) => ({
          time: bar.time as UTCTimestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }));

        const baselineSeries = incomingHistory.length > 0 ? incomingHistory : next[row.symbol] ?? [];
        const currentSeries = [...baselineSeries].sort((left, right) => Number(left.time) - Number(right.time));
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
  }, [lastPacket, liveRows]);

  useEffect(() => {
    if (!lastPacket || lastPacket.dashboard_id !== dashboardId || livePacketNotifications.length === 0) {
      return;
    }

    setLiveNotificationEvents((prev) => {
      const seen = new Set(prev.map((event) => event.id));
      const nextBatch = livePacketNotifications.filter((event) => event.dashboardId === dashboardId && !seen.has(event.id));
      if (nextBatch.length === 0) {
        return prev;
      }

      const merged = [...nextBatch, ...prev];
      return merged.slice(0, 12);
    });
  }, [dashboardId, lastPacket, livePacketNotifications]);

  useEffect(() => {
    if (selectedSymbol && !availableSymbols.includes(selectedSymbol)) {
      setSelectedSymbol('');
    }
  }, [availableSymbols, selectedSymbol]);

  const selectedRow = selectedSymbol ? rows.find((row) => row.symbol === selectedSymbol) ?? null : null;
  const selectedHistory = useMemo(() => (selectedSymbol ? historyBySymbol[selectedSymbol] ?? [] : []), [historyBySymbol, selectedSymbol]);
  const filteredHistory = useMemo(() => {
    const maxBars = TIMERANGE_TO_BARS[timerange];
    return selectedHistory.slice(-maxBars);
  }, [selectedHistory, timerange]);

  const chartMarkers = useMemo(() => {
    if (!selectedRow || filteredHistory.length === 0) {
      return [];
    }

    const marker = buildSignalMarker(
      selectedRow,
      activeDashboard?.indicatorId,
      filteredHistory[filteredHistory.length - 1].time as UTCTimestamp,
    );
    return marker ? [marker] : [];
  }, [activeDashboard?.indicatorId, selectedRow, filteredHistory]);

  const watchlistRows = useMemo(() => {
    const scopedRows = rows.filter((row) => (activeDashboard?.symbols ?? []).includes(row.symbol));
    return scopedRows.map((row) =>
      toWatchlistRow(row, activeDashboard?.indicatorId, historyBySymbol[row.symbol] ?? [], lastPacket?.as_of_epoch),
    );
  }, [activeDashboard?.indicatorId, activeDashboard?.symbols, historyBySymbol, lastPacket?.as_of_epoch, rows]);

  const streamLabel =
    connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting';

  const onOpenCreateDashboard = () => {
    setIsEditingDashboard(false);
    setDashboardForm({
      name: '',
      description: '',
      indicatorId: indicators[0]?.id ?? BUILT_IN_INDICATORS[0].id,
      symbols: ['FPT', 'HPG', 'VCB'],
    });
    setSymbolSearch('');
    if (symbolCatalog.length <= DEFAULT_SYMBOL_CATALOG.length) {
      void refreshSymbolCatalog();
    }
    setIsDashboardModalOpen(true);
  };

  const onOpenEditDashboard = () => {
    if (!activeDashboard) {
      return;
    }

    setIsEditingDashboard(true);
    setDashboardForm({
      name: activeDashboard.name,
      description: activeDashboard.description,
      indicatorId: activeDashboard.indicatorId,
      symbols: normalizeSymbolList(activeDashboard.symbols),
    });
    setSymbolSearch('');
    if (symbolCatalog.length <= DEFAULT_SYMBOL_CATALOG.length) {
      void refreshSymbolCatalog();
    }
    setIsDashboardModalOpen(true);
  };

  const onToggleDashboardSymbol = (symbol: string) => {
    setDashboardForm((prev) => {
      const exists = prev.symbols.includes(symbol);
      return {
        ...prev,
        symbols: exists ? prev.symbols.filter((entry) => entry !== symbol) : [...prev.symbols, symbol],
      };
    });
  };

  const onSaveDashboard = async () => {
    const symbols = normalizeSymbolList(dashboardForm.symbols);
    if (!dashboardForm.name.trim() || symbols.length === 0) {
      return;
    }

    setIsPersisting(true);
    setConfigError(null);
    try {
      if (isEditingDashboard && activeDashboard) {
        const response = await requestJson<ApiListResponse<DashboardDefinition>>(
          `/api/dashboards/${activeDashboard.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name: dashboardForm.name.trim(),
              description: dashboardForm.description.trim(),
              indicatorId: dashboardForm.indicatorId,
              symbols,
            }),
          },
        );

        if (response.item) {
          setDashboards((prev) =>
            prev.map((dashboard) => (dashboard.id === response.item?.id ? response.item : dashboard)),
          );
        }
      } else {
        const response = await requestJson<ApiListResponse<DashboardDefinition>>('/api/dashboards', {
          method: 'POST',
          body: JSON.stringify({
            name: dashboardForm.name.trim(),
            description: dashboardForm.description.trim(),
            indicatorId: dashboardForm.indicatorId,
            symbols,
          }),
        });

        if (response.item) {
          setDashboards((prev) => [...prev, response.item as DashboardDefinition]);
          setSelectedDashboardId(response.item.id);
        }
      }

      setIsDashboardModalOpen(false);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to persist dashboard changes.');
    } finally {
      setIsPersisting(false);
    }
  };

  const onOpenIndicatorManager = () => {
    const seed = activeIndicator ?? indicators[0] ?? BUILT_IN_INDICATORS[0];
    setActiveIndicatorEditorId(seed.id);
    setIndicatorEditor(toIndicatorEditorState(seed));
    setIsIndicatorModalOpen(true);
  };

  const onSelectIndicatorEditor = (indicatorId: string) => {
    const selected = indicators.find((indicator) => indicator.id === indicatorId);
    if (!selected) {
      return;
    }

    setActiveIndicatorEditorId(selected.id);
    setIndicatorEditor(toIndicatorEditorState(selected));
  };

  const onSaveIndicator = async () => {
    const base = indicators.find((indicator) => indicator.id === activeIndicatorEditorId);
    if (!base || !indicatorEditor.name.trim()) {
      return;
    }

    const parsedParams: Record<string, number> = {};
    for (const [key, value] of Object.entries(indicatorEditor.params)) {
      const numeric = Number.parseFloat(value);
      if (Number.isNaN(numeric)) {
        return;
      }
      parsedParams[key] = numeric;
    }

    setIsPersisting(true);
    setConfigError(null);
    try {
      if (base.isBuiltIn) {
        const response = await requestJson<ApiListResponse<IndicatorDefinition>>('/api/indicators', {
          method: 'POST',
          body: JSON.stringify({
            name: indicatorEditor.name.trim(),
            description: indicatorEditor.description.trim(),
            params: parsedParams,
          }),
        });

        if (response.item) {
          const customIndicator = response.item;
          setIndicators((prev) => [...prev, customIndicator]);
          setActiveIndicatorEditorId(customIndicator.id);
          setIndicatorEditor(toIndicatorEditorState(customIndicator));
        }
        return;
      }

      const response = await requestJson<ApiListResponse<IndicatorDefinition>>(
        `/api/indicators/${base.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: indicatorEditor.name.trim(),
            description: indicatorEditor.description.trim(),
            params: parsedParams,
          }),
        },
      );

      if (response.item) {
        setIndicators((prev) => prev.map((indicator) => (indicator.id === response.item?.id ? response.item : indicator)));
      }
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to persist indicator changes.');
    } finally {
      setIsPersisting(false);
    }
  };

  const onCreateCustomIndicator = () => {
    const template = indicators.find((indicator) => indicator.id === activeIndicatorEditorId) ?? indicators[0];
    if (!template) {
      return;
    }

    const customDraft: IndicatorDefinition = {
      ...template,
      id: `custom_draft_${Date.now().toString().slice(-8)}`,
      name: `${template.name} Custom`,
      description: template.description,
      isBuiltIn: false,
    };

    setIndicators((prev) => [...prev, customDraft]);
    setActiveIndicatorEditorId(customDraft.id);
    setIndicatorEditor(toIndicatorEditorState(customDraft));
  };

  const onAssignIndicatorToDashboard = async () => {
    if (!activeDashboard) {
      return;
    }

    setIsPersisting(true);
    setConfigError(null);
    try {
      const response = await requestJson<ApiListResponse<DashboardDefinition>>(`/api/dashboards/${activeDashboard.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          indicatorId: activeIndicatorEditorId,
        }),
      });

      if (response.item) {
        setDashboards((prev) =>
          prev.map((dashboard) => (dashboard.id === response.item?.id ? response.item : dashboard)),
        );
      }
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to assign indicator to dashboard.');
    } finally {
      setIsPersisting(false);
    }
  };

  const onOpenNotificationManager = () => {
    setNotificationError(null);
    const firstRule = notificationRules[0] ?? null;
    setNotificationForm(toNotificationFormState(firstRule, dashboards));
    setIsNotificationModalOpen(true);
  };

  const onCreateNotificationRule = () => {
    setNotificationError(null);
    setNotificationForm(toNotificationFormState(null, dashboards));
  };

  const onSelectNotificationRule = (ruleId: string) => {
    const selected = notificationRules.find((entry) => entry.id === ruleId) ?? null;
    setNotificationError(null);
    setNotificationForm(toNotificationFormState(selected, dashboards));
  };

  const onNotificationDashboardChange = (dashboardId: string) => {
    const symbols = getDashboardSymbols(dashboards, dashboardId);
    setNotificationForm((prev) => {
      const nextSymbol = symbols.includes(prev.symbol) ? prev.symbol : (symbols[0] ?? '');
      return {
        ...prev,
        dashboardId,
        symbol: nextSymbol,
      };
    });
  };

  const onSaveNotificationRule = async () => {
    if (!notificationForm.name.trim() || !notificationForm.dashboardId || !notificationForm.symbol.trim() || !notificationForm.indicatorId) {
      setNotificationError('Name, dashboard, symbol, and indicator are required.');
      return;
    }

    const parsedCondition = parseNotificationCondition(notificationForm.conditionJson);
    if (!parsedCondition) {
      setNotificationError('Condition JSON is invalid.');
      return;
    }

    const parsedCooldown = Number(notificationForm.cooldownSeconds);
    if (!Number.isFinite(parsedCooldown) || parsedCooldown < 0) {
      setNotificationError('Cooldown must be a non-negative number.');
      return;
    }

    setIsPersisting(true);
    setNotificationError(null);
    setConfigError(null);
    try {
      if (notificationForm.id) {
        const response = await requestJson<ApiListResponse<NotificationRule>>(`/api/notifications/${notificationForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: notificationForm.name.trim(),
            dashboardId: notificationForm.dashboardId,
            symbol: notificationForm.symbol.trim().toUpperCase(),
            indicatorId: notificationForm.indicatorId,
            condition: parsedCondition,
            channels: {
              inApp: notificationForm.channelsInApp,
              push: notificationForm.channelsPush,
            },
            cooldownSeconds: Math.floor(parsedCooldown),
            enabled: notificationForm.enabled,
          }),
        });

        if (response.item) {
          setNotificationRules((prev) => prev.map((rule) => (rule.id === response.item?.id ? response.item : rule)));
          setNotificationForm(toNotificationFormState(response.item, dashboards));
        }
      } else {
        const response = await requestJson<ApiListResponse<NotificationRule>>('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({
            name: notificationForm.name.trim(),
            dashboardId: notificationForm.dashboardId,
            symbol: notificationForm.symbol.trim().toUpperCase(),
            indicatorId: notificationForm.indicatorId,
            condition: parsedCondition,
            channels: {
              inApp: notificationForm.channelsInApp,
              push: notificationForm.channelsPush,
            },
            cooldownSeconds: Math.floor(parsedCooldown),
            enabled: notificationForm.enabled,
          }),
        });

        if (response.item) {
          setNotificationRules((prev) => [...prev, response.item as NotificationRule]);
          setNotificationForm(toNotificationFormState(response.item, dashboards));
        }
      }
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : 'Failed to persist notification rule.');
    } finally {
      setIsPersisting(false);
    }
  };

  return (
    <main className="min-h-screen px-4 py-6 text-slate-100 sm:px-6 sm:py-7 lg:px-10 lg:py-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="rounded-3xl border border-slate-800/90 bg-[color:var(--panel)]/95 px-5 py-4 shadow-glow sm:px-6 sm:py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="w-full max-w-3xl">
              <h1 className="text-2xl font-bold leading-tight text-slate-50 sm:text-4xl">📈 Candlestick</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400 sm:mt-3">
                Manage multiple dashboards, assign a single active indicator per dashboard, and monitor live symbol analysis.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <label className="text-xs uppercase tracking-[0.24em] text-slate-500" htmlFor="dashboard-selector">
                  Dashboard
                </label>
                <select
                  id="dashboard-selector"
                  value={selectedDashboardId}
                  onChange={(event) => setSelectedDashboardId(event.target.value)}
                  disabled={dashboards.length === 0}
                  className="rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
                >
                  {dashboards.length === 0 ? <option value="">No dashboards</option> : null}
                  {dashboards.map((dashboard) => (
                    <option key={dashboard.id} value={dashboard.id}>
                      {dashboard.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={onOpenCreateDashboard}
                  className="rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/25"
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={onOpenEditDashboard}
                  className="rounded-xl border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500"
                >
                  Edit
                </button>
                <span className="h-7 w-px bg-slate-700/90" aria-hidden="true" />
                <button
                  type="button"
                  onClick={onOpenIndicatorManager}
                  className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20"
                >
                  Indicators
                </button>
                <span className="h-7 w-px bg-slate-700/90" aria-hidden="true" />
                <button
                  type="button"
                  onClick={onOpenNotificationManager}
                  className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
                >
                  Notifications
                </button>
              </div>

              <div className="mt-3 rounded-2xl border border-slate-700/80 bg-slate-950/45 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Active Indicator</p>
                <p className="mt-1 text-base font-semibold text-slate-100">{activeIndicator?.name ?? 'Unavailable'}</p>
                <p className="mt-1 text-sm text-slate-400">{activeIndicator?.description ?? 'No description available.'}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-700/90 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-8">
                <span className="text-cyan-100/90">Stream</span>
                <span
                  className={[
                    'font-semibold',
                    connected
                      ? 'text-emerald-300'
                      : connectionState === 'reconnecting'
                        ? 'text-amber-300'
                        : 'text-cyan-200',
                  ].join(' ')}
                >
                  {streamLabel}
                </span>
              </div>
              <div className={['mt-2 text-xs', error ? 'text-rose-300' : 'text-cyan-200/80'].join(' ')}>
                {error ?? 'Awaiting dashboard packets'}
              </div>
              {configError ? <div className="mt-1 text-xs text-rose-400">{configError}</div> : null}
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-800/90 bg-[color:var(--panel)]/95 px-5 py-4 shadow-glow sm:px-6 sm:py-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Live Event Feed</p>
            </div>
            <p className="text-sm text-cyan-200/85">
              {liveNotificationEvents.length > 0
                ? `${liveNotificationEvents.length} event${liveNotificationEvents.length === 1 ? '' : 's'} buffered`
                : 'Waiting for notification packets'}
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {liveNotificationEvents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-cyan-500/25 bg-slate-950/40 px-4 py-5 text-sm text-cyan-200/70 md:col-span-2 xl:col-span-3">
                No live notification events yet. Events marked for in-app delivery will appear here as packets arrive.
              </div>
            ) : null}

            {liveNotificationEvents.map((event) => (
              <article
                key={event.id}
                className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-slate-950/70 to-slate-950/80 px-4 py-3 shadow-[0_0_30px_rgba(245,158,11,0.08)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.22em] text-amber-200/80">{event.symbol}</p>
                    <h3 className="mt-1 text-base font-semibold text-slate-50">{event.message}</h3>
                  </div>
                  <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                    In-App
                  </span>
                </div>

                <dl className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
                  <div>
                    <dt className="uppercase tracking-[0.18em] text-slate-500">Rule</dt>
                    <dd className="mt-1 text-slate-200">{event.ruleId}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-[0.18em] text-slate-500">Triggered</dt>
                    <dd className="mt-1 text-slate-200">{formatNotificationTime(event.triggeredAtEpoch)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <MetricsTable
            rows={watchlistRows}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={setSelectedSymbol}
            activeIndicatorLabel={activeIndicator?.name ?? 'Indicator'}
          />
          <AnalysisChart
            symbol={selectedSymbol}
            companyName={selectedRow?.company_name ?? ''}
            timerange={timerange}
            onChangeTimerange={setTimerange}
            historicalData={filteredHistory}
            indicatorMarkers={chartMarkers}
          />
        </section>
      </div>

      {isDashboardModalOpen ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-glow">
            <h2 className="text-lg font-semibold text-slate-100">{isEditingDashboard ? 'Edit Dashboard' : 'Add Dashboard'}</h2>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm text-slate-300">
                Name
                <input
                  value={dashboardForm.name}
                  onChange={(event) => setDashboardForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                />
              </label>
              <label className="grid gap-1 text-sm text-slate-300">
                Description
                <input
                  value={dashboardForm.description}
                  onChange={(event) => setDashboardForm((prev) => ({ ...prev, description: event.target.value }))}
                  className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                />
              </label>
              <label className="grid gap-1 text-sm text-slate-300">
                Indicator
                <select
                  value={dashboardForm.indicatorId}
                  onChange={(event) => setDashboardForm((prev) => ({ ...prev, indicatorId: event.target.value }))}
                  className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                >
                  {indicators.map((indicator) => (
                    <option key={indicator.id} value={indicator.id}>
                      {indicator.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm text-slate-300">
                Symbols
                <div className="relative rounded-lg border border-slate-700 bg-slate-950/55 p-3">
                  {(symbolCatalogLoading || isBackgroundFetching) && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/50 backdrop-blur-[1px]">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-500/30 border-t-cyan-500" />
                    </div>
                  )}
                  <input
                    value={symbolSearch}
                    onChange={(event) => setSymbolSearch(event.target.value)}
                    placeholder="Search by symbol, company, or exchange"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-slate-100"
                  />

                  <div className="mt-3 flex flex-wrap gap-2">
                    {dashboardForm.symbols.length === 0 ? (
                      <span className="text-xs text-slate-400">Select at least one symbol.</span>
                    ) : (
                      dashboardForm.symbols.map((symbol) => (
                        <button
                          key={symbol}
                          type="button"
                          onClick={() => onToggleDashboardSymbol(symbol)}
                          className="rounded-full border border-cyan-500/45 bg-cyan-500/12 px-2.5 py-1 text-xs font-semibold text-cyan-100"
                        >
                          {symbol} ×
                        </button>
                      ))
                    )}
                  </div>

                  <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/45">
                    {filteredSymbolCatalog.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-slate-400">No symbols match your search.</div>
                    ) : (
                      filteredSymbolCatalog.map((item) => {
                        const selected = dashboardForm.symbols.includes(item.symbol);
                        return (
                          <button
                            key={item.symbol}
                            type="button"
                            onClick={() => onToggleDashboardSymbol(item.symbol)}
                            className={[
                              'flex w-full items-center justify-between border-b border-slate-800/80 px-3 py-2 text-left text-sm last:border-b-0',
                              selected ? 'bg-cyan-500/10 text-cyan-100' : 'text-slate-200 hover:bg-slate-900/80',
                            ].join(' ')}
                          >
                            <span className="font-semibold">{item.symbol}</span>
                            <span className="ml-3 truncate text-xs text-slate-400">{item.companyName}</span>
                          </button>
                        );
                      })
                    )}
                  </div>

                  {symbolCatalogError ? <p className="mt-2 text-xs text-amber-300">{symbolCatalogError}</p> : null}
                </div>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsDashboardModalOpen(false)}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveDashboard}
                disabled={isPersisting}
                className="rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-2 text-sm font-semibold text-cyan-200"
              >
                {isPersisting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isIndicatorModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-glow">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-100">Indicator Management</h2>
              <button
                type="button"
                onClick={() => setIsIndicatorModalOpen(false)}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[240px_1fr]">
              <aside className="rounded-xl border border-slate-700 bg-slate-950/45 p-3">
                <button
                  type="button"
                  onClick={onCreateCustomIndicator}
                  className="mb-3 w-full rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-200"
                >
                  + New Custom
                </button>
                <div className="grid gap-2">
                  {indicators.map((indicator) => (
                    <button
                      key={indicator.id}
                      type="button"
                      onClick={() => onSelectIndicatorEditor(indicator.id)}
                      className={[
                        'rounded-lg border px-3 py-2 text-left text-sm',
                        activeIndicatorEditorId === indicator.id
                          ? 'border-cyan-400/55 bg-cyan-400/10 text-cyan-100'
                          : 'border-slate-700 bg-slate-900/55 text-slate-300',
                      ].join(' ')}
                    >
                      <div className="font-semibold">{indicator.name}</div>
                      <div className="mt-0.5 text-xs text-slate-400">{indicator.isBuiltIn ? 'Built-in' : 'Custom'}</div>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="rounded-xl border border-slate-700 bg-slate-950/45 p-4">
                <div className="grid gap-3">
                  <label className="grid gap-1 text-sm text-slate-300">
                    Name
                    <input
                      value={indicatorEditor.name}
                      onChange={(event) => setIndicatorEditor((prev) => ({ ...prev, name: event.target.value }))}
                      className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                    />
                  </label>
                  <label className="grid gap-1 text-sm text-slate-300">
                    Description
                    <input
                      value={indicatorEditor.description}
                      onChange={(event) =>
                        setIndicatorEditor((prev) => ({
                          ...prev,
                          description: event.target.value,
                        }))
                      }
                      className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                    />
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(indicatorEditor.params).map(([paramName, paramValue]) => (
                      <label key={paramName} className="grid gap-1 text-sm text-slate-300">
                        {paramName}
                        <input
                          value={paramValue}
                          onChange={(event) =>
                            setIndicatorEditor((prev) => ({
                              ...prev,
                              params: {
                                ...prev.params,
                                [paramName]: event.target.value,
                              },
                            }))
                          }
                          className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={onSaveIndicator}
                    disabled={isPersisting}
                    className="rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-2 text-sm font-semibold text-cyan-200"
                  >
                    {isPersisting ? 'Saving...' : 'Save Indicator'}
                  </button>
                  <button
                    type="button"
                    onClick={onAssignIndicatorToDashboard}
                    disabled={isPersisting}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-2 text-sm font-semibold text-amber-200"
                  >
                    Assign To Current Dashboard
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {isNotificationModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-glow">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-100">Notification Rules</h2>
              <button
                type="button"
                onClick={() => setIsNotificationModalOpen(false)}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
              <aside className="rounded-xl border border-slate-700 bg-slate-950/45 p-3">
                <button
                  type="button"
                  onClick={onCreateNotificationRule}
                  className="mb-3 w-full rounded-lg border border-emerald-500/45 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100"
                >
                  + New Rule
                </button>
                <div className="grid gap-2">
                  {notificationRules.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-700 px-3 py-2 text-xs text-slate-400">No rules yet</div>
                  ) : null}
                  {notificationRules.map((rule) => (
                    <button
                      key={rule.id}
                      type="button"
                      onClick={() => onSelectNotificationRule(rule.id)}
                      className={[
                        'rounded-lg border px-3 py-2 text-left text-sm',
                        notificationForm.id === rule.id
                          ? 'border-emerald-400/55 bg-emerald-400/10 text-emerald-100'
                          : 'border-slate-700 bg-slate-900/55 text-slate-300',
                      ].join(' ')}
                    >
                      <div className="font-semibold">{rule.name}</div>
                      <div className="mt-0.5 text-xs text-slate-400">{rule.symbol} - {rule.enabled ? 'Enabled' : 'Disabled'}</div>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="rounded-xl border border-slate-700 bg-slate-950/45 p-4">
                <div className="grid gap-3">
                  <label className="grid gap-1 text-sm text-slate-300">
                    Rule Name
                    <input
                      value={notificationForm.name}
                      onChange={(event) => setNotificationForm((prev) => ({ ...prev, name: event.target.value }))}
                      className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-sm text-slate-300">
                      Dashboard
                      <select
                        value={notificationForm.dashboardId}
                        onChange={(event) => onNotificationDashboardChange(event.target.value)}
                        className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                      >
                        {dashboards.map((dashboard) => (
                          <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm text-slate-300">
                      Indicator
                      <select
                        value={notificationForm.indicatorId}
                        onChange={(event) => setNotificationForm((prev) => ({ ...prev, indicatorId: event.target.value }))}
                        className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                      >
                        {indicators.map((indicator) => (
                          <option key={indicator.id} value={indicator.id}>{indicator.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid min-w-0 gap-1 text-sm text-slate-300">
                      Symbol
                      <select
                        value={notificationForm.symbol}
                        onChange={(event) => setNotificationForm((prev) => ({ ...prev, symbol: event.target.value }))}
                        disabled={notificationSymbolOptions.length === 0}
                        className="w-full max-w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                      >
                        {notificationSymbolOptions.length === 0 ? (
                          <option value="">No symbols for selected dashboard</option>
                        ) : null}
                        {notificationSymbolOptions.map((option) => (
                          <option key={option.symbol} value={option.symbol}>
                            {option.symbol} - {option.companyName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm text-slate-300">
                      Cooldown (seconds)
                      <input
                        type="number"
                        min={0}
                        value={notificationForm.cooldownSeconds}
                        onChange={(event) => setNotificationForm((prev) => ({ ...prev, cooldownSeconds: event.target.value }))}
                        className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100"
                      />
                    </label>
                  </div>
                  <label className="grid gap-1 text-sm text-slate-300">
                    Condition (JSON)
                    <textarea
                      value={notificationForm.conditionJson}
                      onChange={(event) => setNotificationForm((prev) => ({ ...prev, conditionJson: event.target.value }))}
                      className="min-h-[150px] rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-100"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={notificationForm.enabled}
                        onChange={(event) => setNotificationForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                      />
                      Enabled
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={notificationForm.channelsInApp}
                        onChange={(event) =>
                          setNotificationForm((prev) => ({ ...prev, channelsInApp: event.target.checked }))
                        }
                      />
                      In-App Channel
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={notificationForm.channelsPush}
                        onChange={(event) =>
                          setNotificationForm((prev) => ({ ...prev, channelsPush: event.target.checked }))
                        }
                      />
                      Push Channel
                    </label>
                  </div>
                  {notificationError ? <p className="text-sm text-rose-300">{notificationError}</p> : null}
                </div>

                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={onSaveNotificationRule}
                    disabled={isPersisting}
                    className="rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-200"
                  >
                    {isPersisting ? 'Saving...' : notificationForm.id ? 'Save Rule' : 'Create Rule'}
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
