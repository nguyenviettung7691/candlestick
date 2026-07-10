import type {
  IndicatorSignal,
  NotificationChannelConfig,
  NotificationComparator,
  NotificationCondition,
  NotificationGroupOperator,
  NotificationMetricField,
  NotificationSignalField,
} from '@/lib/types';

const VALID_SIGNALS: Set<IndicatorSignal> = new Set([
  'BUY',
  'SELL',
  'NEUTRAL',
  'SHOCK_ACCUMULATION',
  'SHOCK_DISTRIBUTION',
  'BUY_OVERSOLD',
  'SELL_OVERBOUGHT',
  'BULLISH_TREND',
  'BEARISH_TREND',
]);

const VALID_METRIC_FIELDS: Set<NotificationMetricField> = new Set([
  'price',
  'mtf_score',
  'ls_ratio',
  'z_score',
  'trend_delta',
]);

const VALID_SIGNAL_FIELDS: Set<NotificationSignalField> = new Set([
  'mtf_signal',
  'ls_signal',
  'z_signal',
  'trend_signal',
]);

const VALID_COMPARATORS: Set<NotificationComparator> = new Set(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ']);
const VALID_GROUP_OPERATORS: Set<NotificationGroupOperator> = new Set(['AND', 'OR']);

export function normalizeChannels(value: unknown): NotificationChannelConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const channels = value as Record<string, unknown>;
  if (typeof channels.inApp !== 'boolean' || typeof channels.push !== 'boolean') {
    return null;
  }

  return {
    inApp: channels.inApp,
    push: channels.push,
  };
}

export function normalizeCondition(value: unknown): NotificationCondition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const condition = value as Record<string, unknown>;
  if (condition.type === 'signal') {
    if (!VALID_SIGNAL_FIELDS.has(condition.field as NotificationSignalField)) {
      return null;
    }
    if (!VALID_SIGNALS.has(condition.signal as IndicatorSignal)) {
      return null;
    }
    return {
      type: 'signal',
      field: condition.field as NotificationSignalField,
      signal: condition.signal as IndicatorSignal,
    };
  }

  if (condition.type === 'metric') {
    if (!VALID_METRIC_FIELDS.has(condition.field as NotificationMetricField)) {
      return null;
    }
    if (!VALID_COMPARATORS.has(condition.comparator as NotificationComparator)) {
      return null;
    }
    const numeric = Number(condition.value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return {
      type: 'metric',
      field: condition.field as NotificationMetricField,
      comparator: condition.comparator as NotificationComparator,
      value: numeric,
    };
  }

  if (condition.type === 'group') {
    if (!VALID_GROUP_OPERATORS.has(condition.operator as NotificationGroupOperator)) {
      return null;
    }
    if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) {
      return null;
    }

    const normalizedChildren: NotificationCondition[] = [];
    for (const child of condition.conditions) {
      const normalized = normalizeCondition(child);
      if (!normalized) {
        return null;
      }
      normalizedChildren.push(normalized);
    }

    return {
      type: 'group',
      operator: condition.operator as NotificationGroupOperator,
      conditions: normalizedChildren,
    };
  }

  return null;
}
