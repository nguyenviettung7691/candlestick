import type {
  DashboardTickerSnapshot,
  NotificationComparator,
  NotificationCondition,
  NotificationRule,
  StreamPacket,
} from '@/lib/types';

/**
 * Pure client-side notification evaluation.
 *
 * This replaces the server-side `_evaluate_dashboard_notifications` logic that
 * used to run inside the AWS Lambda poller. The browser now owns rule
 * evaluation: every WebSocket packet is checked against the user's rules and
 * matching rules produce {@link NotificationEvent} records that are persisted
 * to IndexedDB and surfaced in the in-app feed.
 */

function compareValues(left: number, comparator: NotificationComparator, right: number): boolean {
  switch (comparator) {
    case 'GT':
      return left > right;
    case 'GTE':
      return left >= right;
    case 'LT':
      return left < right;
    case 'LTE':
      return left <= right;
    case 'EQ':
      return left === right;
    case 'NEQ':
      return left !== right;
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: NotificationCondition | null | undefined,
  snapshot: DashboardTickerSnapshot,
): boolean {
  if (!condition || typeof condition !== 'object') {
    return false;
  }

  switch (condition.type) {
    case 'signal': {
      const field = condition.field;
      const expected = condition.signal;
      if (!field || !expected) {
        return false;
      }
      return String(snapshot[field]) === String(expected);
    }
    case 'metric': {
      const field = condition.field;
      const comparator = condition.comparator;
      const rawValue = condition.value;
      if (!field || !comparator || rawValue === undefined || rawValue === null) {
        return false;
      }
      const metric = Number(snapshot[field]);
      if (!Number.isFinite(metric)) {
        return false;
      }
      return compareValues(metric, comparator, Number(rawValue));
    }
    case 'group': {
      const operator = (condition.operator ?? 'AND').toUpperCase();
      const children = Array.isArray(condition.conditions) ? condition.conditions : [];
      if (children.length === 0) {
        return false;
      }
      const results = children.map((child) => evaluateCondition(child, snapshot));
      return operator === 'OR' ? results.some(Boolean) : results.every(Boolean);
    }
    default:
      return false;
  }
}

function describeCondition(condition: NotificationCondition | null | undefined): string {
  if (!condition || typeof condition !== 'object') {
    return 'condition met';
  }

  switch (condition.type) {
    case 'signal':
      return `${condition.field} is ${condition.signal}`;
    case 'metric':
      return `${condition.field} ${condition.comparator} ${condition.value}`;
    case 'group': {
      const operator = (condition.operator ?? 'AND').toUpperCase();
      const parts = (condition.conditions ?? []).map(describeCondition);
      return parts.join(` ${operator} `);
    }
    default:
      return 'condition met';
  }
}

export function buildNotificationMessage(rule: NotificationRule, snapshot: DashboardTickerSnapshot): string {
  const detail = describeCondition(rule.condition);
  return `${rule.name}: ${rule.symbol} @ ${snapshot.price} — ${detail}`;
}

export interface FiredRule {
  rule: NotificationRule;
  snapshot: DashboardTickerSnapshot;
}

/**
 * Returns the rules that should fire for the given packet, honoring the
 * `enabled` flag, dashboard scoping, the condition match, and the per-rule
 * cooldown (based on `rule.lastTriggeredAtEpoch`).
 */
export function findFiredRules(
  rules: NotificationRule[],
  packet: StreamPacket,
  nowEpoch: number,
): FiredRule[] {
  const data = packet.data ?? {};
  const fired: FiredRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }
    if (rule.dashboardId !== packet.dashboard_id) {
      continue;
    }

    const snapshot = data[rule.symbol];
    if (!snapshot) {
      continue;
    }
    if (!evaluateCondition(rule.condition, snapshot)) {
      continue;
    }

    const last = rule.lastTriggeredAtEpoch;
    if (typeof last === 'number' && last > 0 && nowEpoch - last < rule.cooldownSeconds) {
      continue;
    }

    fired.push({ rule, snapshot });
  }

  return fired;
}
