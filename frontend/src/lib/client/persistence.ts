function randomUUID(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

import {
  STORE_DASHBOARDS,
  STORE_INDICATORS,
  STORE_NOTIFICATION_EVENTS,
  STORE_NOTIFICATION_RULES,
  STORE_PUSH_SUBSCRIPTIONS,
  deleteFromStore,
  getAllFromStore,
  getDb,
  putInStore,
} from '@/lib/client/db';
import type {
  DashboardDefinition,
  IndicatorDefinition,
  NotificationChannelConfig,
  NotificationCondition,
  NotificationEvent,
  NotificationRule,
  PushSubscriptionRecord,
} from '@/lib/types';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export async function listDashboards(): Promise<DashboardDefinition[]> {
  const items = await getAllFromStore<DashboardDefinition>(STORE_DASHBOARDS);
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createDashboard(
  input: Omit<DashboardDefinition, 'id'>,
): Promise<DashboardDefinition> {
  const dashboard: DashboardDefinition = {
    id: `dash_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    name: input.name,
    description: input.description,
    indicatorId: input.indicatorId,
    symbols: input.symbols,
  };
  await putInStore(STORE_DASHBOARDS, dashboard);
  return dashboard;
}

export async function updateDashboard(
  dashboardId: string,
  input: Partial<Omit<DashboardDefinition, 'id'>>,
): Promise<DashboardDefinition | null> {
  const db = await getDb();
  const existing = await db.get(STORE_DASHBOARDS, dashboardId);
  if (!existing) {
    return null;
  }

  const updated: DashboardDefinition = {
    ...existing,
    id: dashboardId,
  };
  if (typeof input.name === 'string') {
    updated.name = input.name;
  }
  if (typeof input.description === 'string') {
    updated.description = input.description;
  }
  if (typeof input.indicatorId === 'string') {
    updated.indicatorId = input.indicatorId;
  }
  if (Array.isArray(input.symbols)) {
    updated.symbols = input.symbols;
  }

  await db.put(STORE_DASHBOARDS, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Custom Indicators
// ---------------------------------------------------------------------------

export async function listCustomIndicators(): Promise<IndicatorDefinition[]> {
  const items = await getAllFromStore<IndicatorDefinition>(STORE_INDICATORS);
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createIndicator(
  input: Omit<IndicatorDefinition, 'id' | 'isBuiltIn'>,
): Promise<IndicatorDefinition> {
  const indicator: IndicatorDefinition = {
    id: `custom_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    name: input.name,
    description: input.description,
    params: input.params,
    isBuiltIn: false,
  };
  await putInStore(STORE_INDICATORS, indicator);
  return indicator;
}

export async function updateIndicator(
  indicatorId: string,
  input: Partial<Omit<IndicatorDefinition, 'id' | 'isBuiltIn'>>,
): Promise<IndicatorDefinition | null> {
  const db = await getDb();
  const existing = await db.get(STORE_INDICATORS, indicatorId);
  if (!existing) {
    return null;
  }

  const updated: IndicatorDefinition = {
    ...existing,
    id: indicatorId,
    isBuiltIn: false,
  };
  if (typeof input.name === 'string') {
    updated.name = input.name;
  }
  if (typeof input.description === 'string') {
    updated.description = input.description;
  }
  if (input.params && typeof input.params === 'object') {
    updated.params = input.params;
  }

  await db.put(STORE_INDICATORS, updated);
  return updated;
}

// Delete a custom indicator by its ID
export async function deleteIndicator(indicatorId: string): Promise<void> {
  await deleteFromStore(STORE_INDICATORS, indicatorId);
}

// Fetch a single custom indicator by its ID. Returns `undefined` when the
// record does not exist in the `indicators` store.
export async function getIndicatorById(id: string): Promise<IndicatorDefinition | undefined> {
  const db = await getDb();
  return db.get(STORE_INDICATORS, id);
}

// ---------------------------------------------------------------------------
// Notification Rules
// ---------------------------------------------------------------------------

export async function listNotificationRules(): Promise<NotificationRule[]> {
  const items = await getAllFromStore<NotificationRule>(STORE_NOTIFICATION_RULES);
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createNotificationRule(
  input: Omit<NotificationRule, 'id' | 'createdAtEpoch' | 'updatedAtEpoch' | 'lastTriggeredAtEpoch'>,
): Promise<NotificationRule> {
  const now = nowSeconds();
  const rule: NotificationRule = {
    id: `rule_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    name: input.name,
    dashboardId: input.dashboardId,
    symbol: input.symbol,
    indicatorId: input.indicatorId,
    condition: input.condition,
    channels: input.channels,
    cooldownSeconds: input.cooldownSeconds,
    enabled: input.enabled,
    createdAtEpoch: now,
    updatedAtEpoch: now,
  };
  await putInStore(STORE_NOTIFICATION_RULES, rule);
  return rule;
}

export async function updateNotificationRule(
  ruleId: string,
  input: Partial<Omit<NotificationRule, 'id' | 'createdAtEpoch' | 'updatedAtEpoch'>>,
): Promise<NotificationRule | null> {
  const db = await getDb();
  const existing = await db.get(STORE_NOTIFICATION_RULES, ruleId);
  if (!existing) {
    return null;
  }

  const updated: NotificationRule = {
    ...existing,
    id: ruleId,
    updatedAtEpoch: nowSeconds(),
  };
  if (typeof input.name === 'string') {
    updated.name = input.name;
  }
  if (typeof input.dashboardId === 'string') {
    updated.dashboardId = input.dashboardId;
  }
  if (typeof input.symbol === 'string') {
    updated.symbol = input.symbol;
  }
  if (typeof input.indicatorId === 'string') {
    updated.indicatorId = input.indicatorId;
  }
  if (input.condition && typeof input.condition === 'object') {
    updated.condition = input.condition;
  }
  if (input.channels && typeof input.channels === 'object') {
    updated.channels = input.channels;
  }
  if (typeof input.cooldownSeconds === 'number') {
    updated.cooldownSeconds = input.cooldownSeconds;
  }
  if (typeof input.enabled === 'boolean') {
    updated.enabled = input.enabled;
  }
  if (typeof input.lastTriggeredAtEpoch === 'number') {
    updated.lastTriggeredAtEpoch = input.lastTriggeredAtEpoch;
  }

  await db.put(STORE_NOTIFICATION_RULES, updated);
  return updated;
}

// Delete a notification rule by its ID
export async function deleteNotificationRule(ruleId: string): Promise<void> {
  await deleteFromStore(STORE_NOTIFICATION_RULES, ruleId);
}

// ---------------------------------------------------------------------------
// Notification Events
// ---------------------------------------------------------------------------

export async function listNotificationEvents(limit = 50): Promise<NotificationEvent[]> {
  const items = await getAllFromStore<NotificationEvent>(STORE_NOTIFICATION_EVENTS);
  return items
    .sort((left, right) => right.triggeredAtEpoch - left.triggeredAtEpoch)
    .slice(0, limit);
}

export async function createNotificationEvent(
  input: Omit<NotificationEvent, 'id' | 'triggeredAtEpoch'> & { triggeredAtEpoch?: number },
): Promise<NotificationEvent> {
  const event: NotificationEvent = {
    id: `evt_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    ruleId: input.ruleId,
    dashboardId: input.dashboardId,
    symbol: input.symbol,
    message: input.message,
    triggeredAtEpoch: input.triggeredAtEpoch ?? nowSeconds(),
    channels: input.channels,
  };
  await putInStore(STORE_NOTIFICATION_EVENTS, event);
  return event;
}

// ---------------------------------------------------------------------------
// Push Subscriptions
// ---------------------------------------------------------------------------

export async function listPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
  return getAllFromStore<PushSubscriptionRecord>(STORE_PUSH_SUBSCRIPTIONS);
}

export async function upsertPushSubscription(
  input: Pick<PushSubscriptionRecord, 'endpoint' | 'keys'>,
): Promise<PushSubscriptionRecord> {
  const db = await getDb();
  const existing = await db.get(STORE_PUSH_SUBSCRIPTIONS, input.endpoint);
  const now = nowSeconds();
  const subscription: PushSubscriptionRecord = {
    endpoint: input.endpoint,
    keys: input.keys,
    createdAtEpoch: existing?.createdAtEpoch ?? now,
    updatedAtEpoch: now,
  };
  await db.put(STORE_PUSH_SUBSCRIPTIONS, subscription);
  return subscription;
}

export async function deletePushSubscription(endpoint: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get(STORE_PUSH_SUBSCRIPTIONS, endpoint);
  if (!existing) {
    return false;
  }
  await deleteFromStore(STORE_PUSH_SUBSCRIPTIONS, endpoint);
  return true;
}

// Re-export types for convenience so callers can import from one place.
export type {
  DashboardDefinition,
  IndicatorDefinition,
  NotificationChannelConfig,
  NotificationCondition,
  NotificationEvent,
  NotificationRule,
  PushSubscriptionRecord,
};
