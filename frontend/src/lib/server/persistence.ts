import { createHash, randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import type {
  DashboardDefinition,
  IndicatorDefinition,
  NotificationChannelConfig,
  NotificationCondition,
  NotificationEvent,
  NotificationRule,
  PushSubscriptionRecord,
} from '@/lib/types';

interface SessionRecord {
  token: string;
  userId: string;
  expiresAtEpoch: number;
}

interface DashboardItem {
  PK: string;
  SK: string;
  entity_type: 'DASHBOARD';
  dashboard_id: string;
  dashboard_name: string;
  description: string;
  indicator_id: string;
  symbols: string[];
  created_at: number;
  updated_at: number;
}

interface IndicatorItem {
  PK: string;
  SK: string;
  entity_type: 'INDICATOR';
  indicator_id: string;
  indicator_name: string;
  description: string;
  params: Record<string, number>;
  is_built_in: false;
  created_at: number;
  updated_at: number;
}

interface SessionItem {
  PK: string;
  SK: 'META';
  entity_type: 'SESSION';
  session_token: string;
  user_id: string;
  expires_at_epoch: number;
  ttl: number;
}

interface NotificationRuleItem {
  PK: string;
  SK: string;
  entity_type: 'NOTIFICATION_RULE';
  notification_rule_id: string;
  rule_name: string;
  dashboard_id: string;
  symbol: string;
  indicator_id: string;
  condition: NotificationCondition;
  channels: NotificationChannelConfig;
  cooldown_seconds: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  last_triggered_at?: number;
}

interface NotificationEventItem {
  PK: string;
  SK: string;
  entity_type: 'NOTIFICATION_EVENT';
  notification_event_id: string;
  notification_rule_id: string;
  dashboard_id: string;
  symbol: string;
  message: string;
  triggered_at: number;
  channels: NotificationChannelConfig;
  created_at: number;
}

interface PushSubscriptionItem {
  PK: string;
  SK: string;
  entity_type: 'PUSH_SUBSCRIPTION';
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  created_at: number;
  updated_at: number;
}

interface MemoryStore {
  dashboardsByUser: Map<string, DashboardDefinition[]>;
  indicatorsByUser: Map<string, IndicatorDefinition[]>;
  notificationRulesByUser: Map<string, NotificationRule[]>;
  notificationEventsByUser: Map<string, NotificationEvent[]>;
  pushSubscriptionsByUser: Map<string, PushSubscriptionRecord[]>;
  sessions: Map<string, SessionRecord>;
}

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const SESSION_TTL_SECONDS = Number.parseInt(process.env.SESSION_TTL_SECONDS ?? '86400', 10);
const DEV_FALLBACK_ENABLED =
  process.env.CANDLESTICK_DEV_FALLBACK === 'true' || process.env.NODE_ENV !== 'production';

declare global {
  var __candlestickMemoryStore: MemoryStore | undefined;
}

function getMemoryStore(): MemoryStore {
  if (!globalThis.__candlestickMemoryStore) {
    globalThis.__candlestickMemoryStore = {
      dashboardsByUser: new Map<string, DashboardDefinition[]>(),
      indicatorsByUser: new Map<string, IndicatorDefinition[]>(),
      notificationRulesByUser: new Map<string, NotificationRule[]>(),
      notificationEventsByUser: new Map<string, NotificationEvent[]>(),
      pushSubscriptionsByUser: new Map<string, PushSubscriptionRecord[]>(),
      sessions: new Map<string, SessionRecord>(),
    };
  }
  return globalThis.__candlestickMemoryStore;
}

function hasDynamoConfigured(): boolean {
  return typeof TABLE_NAME === 'string' && TABLE_NAME.length > 0;
}

let documentClient: DynamoDBDocumentClient | null = null;

function getDocumentClient(): DynamoDBDocumentClient {
  if (!hasDynamoConfigured()) {
    throw new Error('DYNAMODB_TABLE_NAME is not configured.');
  }
  if (documentClient) {
    return documentClient;
  }

  const baseClient = new DynamoDBClient({});
  documentClient = DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
  return documentClient;
}

function userPk(userId: string): string {
  return `USER#${userId}`;
}

function dashboardSk(dashboardId: string): string {
  return `DASHBOARD#${dashboardId}`;
}

function indicatorSk(indicatorId: string): string {
  return `INDICATOR#${indicatorId}`;
}

function sessionPk(token: string): string {
  return `SESSION#${token}`;
}

function notificationRuleSk(ruleId: string): string {
  return `NOTIFICATION_RULE#${ruleId}`;
}

function notificationEventSk(eventId: string): string {
  return `NOTIFICATION_EVENT#${eventId}`;
}

function pushSubscriptionSk(endpoint: string): string {
  const digest = createHash('sha256').update(endpoint).digest('hex');
  return `PUSH_SUBSCRIPTION#${digest}`;
}

function toDashboardDefinition(item: DashboardItem): DashboardDefinition {
  return {
    id: item.dashboard_id,
    name: item.dashboard_name,
    description: item.description,
    indicatorId: item.indicator_id,
    symbols: item.symbols,
  };
}

function toIndicatorDefinition(item: IndicatorItem): IndicatorDefinition {
  return {
    id: item.indicator_id,
    name: item.indicator_name,
    description: item.description,
    isBuiltIn: false,
    params: item.params,
  };
}

function toNotificationRule(item: NotificationRuleItem): NotificationRule {
  return {
    id: item.notification_rule_id,
    name: item.rule_name,
    dashboardId: item.dashboard_id,
    symbol: item.symbol,
    indicatorId: item.indicator_id,
    condition: item.condition,
    channels: item.channels,
    cooldownSeconds: item.cooldown_seconds,
    enabled: item.enabled,
    createdAtEpoch: item.created_at,
    updatedAtEpoch: item.updated_at,
    lastTriggeredAtEpoch: item.last_triggered_at,
  };
}

function toNotificationEvent(item: NotificationEventItem): NotificationEvent {
  return {
    id: item.notification_event_id,
    ruleId: item.notification_rule_id,
    dashboardId: item.dashboard_id,
    symbol: item.symbol,
    message: item.message,
    triggeredAtEpoch: item.triggered_at,
    channels: item.channels,
  };
}

function toPushSubscriptionRecord(item: PushSubscriptionItem): PushSubscriptionRecord {
  return {
    endpoint: item.endpoint,
    keys: item.keys,
    createdAtEpoch: item.created_at,
    updatedAtEpoch: item.updated_at,
  };
}

export async function createSession(userId: string): Promise<SessionRecord> {
  const token = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAtEpoch = now + SESSION_TTL_SECONDS;
  const session: SessionRecord = {
    token,
    userId,
    expiresAtEpoch,
  };

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for session persistence.');
    }
    const memory = getMemoryStore();
    memory.sessions.set(token, session);
    return session;
  }

  const client = getDocumentClient();
  const item: SessionItem = {
    PK: sessionPk(token),
    SK: 'META',
    entity_type: 'SESSION',
    session_token: token,
    user_id: userId,
    expires_at_epoch: expiresAtEpoch,
    ttl: expiresAtEpoch,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    );
    return session;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    memory.sessions.set(token, session);
    return session;
  }
}

export async function getSession(token: string): Promise<SessionRecord | null> {
  if (!token) {
    return null;
  }

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      return null;
    }
    const session = getMemoryStore().sessions.get(token);
    if (!session || session.expiresAtEpoch <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return session;
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: sessionPk(token),
          SK: 'META',
        },
      }),
    );
    const item = response.Item as SessionItem | undefined;
    if (!item || item.expires_at_epoch <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      token,
      userId: item.user_id,
      expiresAtEpoch: item.expires_at_epoch,
    };
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const session = getMemoryStore().sessions.get(token);
    if (!session || session.expiresAtEpoch <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return session;
  }
}

export async function listDashboards(userId: string): Promise<DashboardDefinition[]> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for dashboard persistence.');
    }
    return [...(getMemoryStore().dashboardsByUser.get(userId) ?? [])];
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':skPrefix': 'DASHBOARD#',
        },
      }),
    );

    const items = (response.Items ?? []) as DashboardItem[];
    return items
      .sort((left, right) => left.dashboard_name.localeCompare(right.dashboard_name))
      .map(toDashboardDefinition);
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    return [...(getMemoryStore().dashboardsByUser.get(userId) ?? [])];
  }
}

export async function createDashboard(
  userId: string,
  input: Omit<DashboardDefinition, 'id'>,
): Promise<DashboardDefinition> {
  const dashboardId = `dash_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const now = Math.floor(Date.now() / 1000);
  const dashboard: DashboardDefinition = {
    id: dashboardId,
    name: input.name,
    description: input.description,
    indicatorId: input.indicatorId,
    symbols: input.symbols,
  };

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for dashboard persistence.');
    }
    const memory = getMemoryStore();
    const existing = memory.dashboardsByUser.get(userId) ?? [];
    memory.dashboardsByUser.set(userId, [...existing, dashboard]);
    return dashboard;
  }

  const client = getDocumentClient();
  const item: DashboardItem = {
    PK: userPk(userId),
    SK: dashboardSk(dashboard.id),
    entity_type: 'DASHBOARD',
    dashboard_id: dashboard.id,
    dashboard_name: dashboard.name,
    description: dashboard.description,
    indicator_id: dashboard.indicatorId,
    symbols: dashboard.symbols,
    created_at: now,
    updated_at: now,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
    return dashboard;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const existing = memory.dashboardsByUser.get(userId) ?? [];
    memory.dashboardsByUser.set(userId, [...existing, dashboard]);
    return dashboard;
  }
}

export async function updateDashboard(
  userId: string,
  dashboardId: string,
  input: Partial<Omit<DashboardDefinition, 'id'>>,
): Promise<DashboardDefinition | null> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for dashboard persistence.');
    }
    const memory = getMemoryStore();
    const current = [...(memory.dashboardsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === dashboardId);
    if (index < 0) {
      return null;
    }
    const updated: DashboardDefinition = {
      ...current[index],
      ...input,
      id: dashboardId,
    };
    current[index] = updated;
    memory.dashboardsByUser.set(userId, current);
    return updated;
  }

  const expressionParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':updated_at': Math.floor(Date.now() / 1000),
  };

  if (typeof input.name === 'string') {
    expressionParts.push('#dashboard_name = :dashboard_name');
    names['#dashboard_name'] = 'dashboard_name';
    values[':dashboard_name'] = input.name;
  }
  if (typeof input.description === 'string') {
    expressionParts.push('#description = :description');
    names['#description'] = 'description';
    values[':description'] = input.description;
  }
  if (typeof input.indicatorId === 'string') {
    expressionParts.push('#indicator_id = :indicator_id');
    names['#indicator_id'] = 'indicator_id';
    values[':indicator_id'] = input.indicatorId;
  }
  if (Array.isArray(input.symbols)) {
    expressionParts.push('#symbols = :symbols');
    names['#symbols'] = 'symbols';
    values[':symbols'] = input.symbols;
  }

  if (expressionParts.length === 0) {
    return getDashboard(userId, dashboardId);
  }

  expressionParts.push('#updated_at = :updated_at');
  names['#updated_at'] = 'updated_at';

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: userPk(userId),
          SK: dashboardSk(dashboardId),
        },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    const item = response.Attributes as DashboardItem | undefined;
    return item ? toDashboardDefinition(item) : null;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const current = [...(memory.dashboardsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === dashboardId);
    if (index < 0) {
      return null;
    }
    const updated: DashboardDefinition = {
      ...current[index],
      ...input,
      id: dashboardId,
    };
    current[index] = updated;
    memory.dashboardsByUser.set(userId, current);
    return updated;
  }
}

async function getDashboard(userId: string, dashboardId: string): Promise<DashboardDefinition | null> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      return null;
    }
    return (getMemoryStore().dashboardsByUser.get(userId) ?? []).find((entry) => entry.id === dashboardId) ?? null;
  }

  const client = getDocumentClient();
  const response = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: userPk(userId),
        SK: dashboardSk(dashboardId),
      },
    }),
  );
  const item = response.Item as DashboardItem | undefined;
  return item ? toDashboardDefinition(item) : null;
}

export async function listCustomIndicators(userId: string): Promise<IndicatorDefinition[]> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for indicator persistence.');
    }
    return [...(getMemoryStore().indicatorsByUser.get(userId) ?? [])];
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':skPrefix': 'INDICATOR#',
        },
      }),
    );

    const items = (response.Items ?? []) as IndicatorItem[];
    return items
      .sort((left, right) => left.indicator_name.localeCompare(right.indicator_name))
      .map(toIndicatorDefinition);
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    return [...(getMemoryStore().indicatorsByUser.get(userId) ?? [])];
  }
}

export async function createIndicator(
  userId: string,
  input: Omit<IndicatorDefinition, 'id' | 'isBuiltIn'>,
): Promise<IndicatorDefinition> {
  const indicator: IndicatorDefinition = {
    id: `custom_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    name: input.name,
    description: input.description,
    params: input.params,
    isBuiltIn: false,
  };

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for indicator persistence.');
    }
    const memory = getMemoryStore();
    const existing = memory.indicatorsByUser.get(userId) ?? [];
    memory.indicatorsByUser.set(userId, [...existing, indicator]);
    return indicator;
  }

  const client = getDocumentClient();
  const now = Math.floor(Date.now() / 1000);
  const item: IndicatorItem = {
    PK: userPk(userId),
    SK: indicatorSk(indicator.id),
    entity_type: 'INDICATOR',
    indicator_id: indicator.id,
    indicator_name: indicator.name,
    description: indicator.description,
    params: indicator.params,
    is_built_in: false,
    created_at: now,
    updated_at: now,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
    return indicator;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const existing = memory.indicatorsByUser.get(userId) ?? [];
    memory.indicatorsByUser.set(userId, [...existing, indicator]);
    return indicator;
  }
}

export async function updateIndicator(
  userId: string,
  indicatorId: string,
  input: Partial<Omit<IndicatorDefinition, 'id' | 'isBuiltIn'>>,
): Promise<IndicatorDefinition | null> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for indicator persistence.');
    }
    const memory = getMemoryStore();
    const current = [...(memory.indicatorsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === indicatorId);
    if (index < 0) {
      return null;
    }
    const updated: IndicatorDefinition = {
      ...current[index],
      ...input,
      id: indicatorId,
      isBuiltIn: false,
    };
    current[index] = updated;
    memory.indicatorsByUser.set(userId, current);
    return updated;
  }

  const names: Record<string, string> = {
    '#updated_at': 'updated_at',
  };
  const values: Record<string, unknown> = {
    ':updated_at': Math.floor(Date.now() / 1000),
  };
  const updates: string[] = ['#updated_at = :updated_at'];

  if (typeof input.name === 'string') {
    names['#indicator_name'] = 'indicator_name';
    values[':indicator_name'] = input.name;
    updates.push('#indicator_name = :indicator_name');
  }
  if (typeof input.description === 'string') {
    names['#description'] = 'description';
    values[':description'] = input.description;
    updates.push('#description = :description');
  }
  if (input.params && typeof input.params === 'object') {
    names['#params'] = 'params';
    values[':params'] = input.params;
    updates.push('#params = :params');
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: userPk(userId),
          SK: indicatorSk(indicatorId),
        },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    const item = response.Attributes as IndicatorItem | undefined;
    return item ? toIndicatorDefinition(item) : null;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const current = [...(memory.indicatorsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === indicatorId);
    if (index < 0) {
      return null;
    }
    const updated: IndicatorDefinition = {
      ...current[index],
      ...input,
      id: indicatorId,
      isBuiltIn: false,
    };
    current[index] = updated;
    memory.indicatorsByUser.set(userId, current);
    return updated;
  }
}

export async function listNotificationRules(userId: string): Promise<NotificationRule[]> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    return [...(getMemoryStore().notificationRulesByUser.get(userId) ?? [])];
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':skPrefix': 'NOTIFICATION_RULE#',
        },
      }),
    );

    const items = (response.Items ?? []) as NotificationRuleItem[];
    return items.sort((left, right) => left.rule_name.localeCompare(right.rule_name)).map(toNotificationRule);
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    return [...(getMemoryStore().notificationRulesByUser.get(userId) ?? [])];
  }
}

export async function createNotificationRule(
  userId: string,
  input: Omit<NotificationRule, 'id' | 'createdAtEpoch' | 'updatedAtEpoch' | 'lastTriggeredAtEpoch'>,
): Promise<NotificationRule> {
  const now = Math.floor(Date.now() / 1000);
  const notificationRule: NotificationRule = {
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

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    const memory = getMemoryStore();
    const existing = memory.notificationRulesByUser.get(userId) ?? [];
    memory.notificationRulesByUser.set(userId, [...existing, notificationRule]);
    return notificationRule;
  }

  const item: NotificationRuleItem = {
    PK: userPk(userId),
    SK: notificationRuleSk(notificationRule.id),
    entity_type: 'NOTIFICATION_RULE',
    notification_rule_id: notificationRule.id,
    rule_name: notificationRule.name,
    dashboard_id: notificationRule.dashboardId,
    symbol: notificationRule.symbol,
    indicator_id: notificationRule.indicatorId,
    condition: notificationRule.condition,
    channels: notificationRule.channels,
    cooldown_seconds: notificationRule.cooldownSeconds,
    enabled: notificationRule.enabled,
    created_at: notificationRule.createdAtEpoch,
    updated_at: notificationRule.updatedAtEpoch,
  };

  const client = getDocumentClient();
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
    return notificationRule;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const existing = memory.notificationRulesByUser.get(userId) ?? [];
    memory.notificationRulesByUser.set(userId, [...existing, notificationRule]);
    return notificationRule;
  }
}

export async function updateNotificationRule(
  userId: string,
  ruleId: string,
  input: Partial<Omit<NotificationRule, 'id' | 'createdAtEpoch' | 'updatedAtEpoch'>>,
): Promise<NotificationRule | null> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    const memory = getMemoryStore();
    const current = [...(memory.notificationRulesByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === ruleId);
    if (index < 0) {
      return null;
    }
    const updated: NotificationRule = {
      ...current[index],
      ...input,
      id: ruleId,
      updatedAtEpoch: Math.floor(Date.now() / 1000),
    };
    current[index] = updated;
    memory.notificationRulesByUser.set(userId, current);
    return updated;
  }

  const names: Record<string, string> = {
    '#updated_at': 'updated_at',
  };
  const values: Record<string, unknown> = {
    ':updated_at': Math.floor(Date.now() / 1000),
  };
  const updates: string[] = ['#updated_at = :updated_at'];

  if (typeof input.name === 'string') {
    names['#rule_name'] = 'rule_name';
    values[':rule_name'] = input.name;
    updates.push('#rule_name = :rule_name');
  }
  if (typeof input.dashboardId === 'string') {
    names['#dashboard_id'] = 'dashboard_id';
    values[':dashboard_id'] = input.dashboardId;
    updates.push('#dashboard_id = :dashboard_id');
  }
  if (typeof input.symbol === 'string') {
    names['#symbol'] = 'symbol';
    values[':symbol'] = input.symbol;
    updates.push('#symbol = :symbol');
  }
  if (typeof input.indicatorId === 'string') {
    names['#indicator_id'] = 'indicator_id';
    values[':indicator_id'] = input.indicatorId;
    updates.push('#indicator_id = :indicator_id');
  }
  if (input.condition && typeof input.condition === 'object') {
    names['#condition'] = 'condition';
    values[':condition'] = input.condition;
    updates.push('#condition = :condition');
  }
  if (input.channels && typeof input.channels === 'object') {
    names['#channels'] = 'channels';
    values[':channels'] = input.channels;
    updates.push('#channels = :channels');
  }
  if (typeof input.cooldownSeconds === 'number') {
    names['#cooldown_seconds'] = 'cooldown_seconds';
    values[':cooldown_seconds'] = input.cooldownSeconds;
    updates.push('#cooldown_seconds = :cooldown_seconds');
  }
  if (typeof input.enabled === 'boolean') {
    names['#enabled'] = 'enabled';
    values[':enabled'] = input.enabled;
    updates.push('#enabled = :enabled');
  }
  if (typeof input.lastTriggeredAtEpoch === 'number') {
    names['#last_triggered_at'] = 'last_triggered_at';
    values[':last_triggered_at'] = input.lastTriggeredAtEpoch;
    updates.push('#last_triggered_at = :last_triggered_at');
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: userPk(userId),
          SK: notificationRuleSk(ruleId),
        },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    const item = response.Attributes as NotificationRuleItem | undefined;
    return item ? toNotificationRule(item) : null;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const current = [...(memory.notificationRulesByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.id === ruleId);
    if (index < 0) {
      return null;
    }
    const updated: NotificationRule = {
      ...current[index],
      ...input,
      id: ruleId,
      updatedAtEpoch: Math.floor(Date.now() / 1000),
    };
    current[index] = updated;
    memory.notificationRulesByUser.set(userId, current);
    return updated;
  }
}

export async function listNotificationEvents(userId: string, limit = 50): Promise<NotificationEvent[]> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    return [...(getMemoryStore().notificationEventsByUser.get(userId) ?? [])]
      .sort((left, right) => right.triggeredAtEpoch - left.triggeredAtEpoch)
      .slice(0, limit);
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':skPrefix': 'NOTIFICATION_EVENT#',
        },
      }),
    );

    const items = (response.Items ?? []) as NotificationEventItem[];
    return items.sort((left, right) => right.triggered_at - left.triggered_at).slice(0, limit).map(toNotificationEvent);
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    return [...(getMemoryStore().notificationEventsByUser.get(userId) ?? [])]
      .sort((left, right) => right.triggeredAtEpoch - left.triggeredAtEpoch)
      .slice(0, limit);
  }
}

export async function createNotificationEvent(
  userId: string,
  input: Omit<NotificationEvent, 'id' | 'triggeredAtEpoch'> & { triggeredAtEpoch?: number },
): Promise<NotificationEvent> {
  const now = Math.floor(Date.now() / 1000);
  const notificationEvent: NotificationEvent = {
    id: `evt_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    ruleId: input.ruleId,
    dashboardId: input.dashboardId,
    symbol: input.symbol,
    message: input.message,
    triggeredAtEpoch: input.triggeredAtEpoch ?? now,
    channels: input.channels,
  };

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    const memory = getMemoryStore();
    const existing = memory.notificationEventsByUser.get(userId) ?? [];
    memory.notificationEventsByUser.set(userId, [notificationEvent, ...existing].slice(0, 200));
    return notificationEvent;
  }

  const item: NotificationEventItem = {
    PK: userPk(userId),
    SK: notificationEventSk(notificationEvent.id),
    entity_type: 'NOTIFICATION_EVENT',
    notification_event_id: notificationEvent.id,
    notification_rule_id: notificationEvent.ruleId,
    dashboard_id: notificationEvent.dashboardId,
    symbol: notificationEvent.symbol,
    message: notificationEvent.message,
    triggered_at: notificationEvent.triggeredAtEpoch,
    channels: notificationEvent.channels,
    created_at: now,
  };

  const client = getDocumentClient();
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
    return notificationEvent;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const existing = memory.notificationEventsByUser.get(userId) ?? [];
    memory.notificationEventsByUser.set(userId, [notificationEvent, ...existing].slice(0, 200));
    return notificationEvent;
  }
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    return [...(getMemoryStore().pushSubscriptionsByUser.get(userId) ?? [])];
  }

  const client = getDocumentClient();
  try {
    const response = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':skPrefix': 'PUSH_SUBSCRIPTION#',
        },
      }),
    );

    const items = (response.Items ?? []) as PushSubscriptionItem[];
    return items.map(toPushSubscriptionRecord);
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    return [...(getMemoryStore().pushSubscriptionsByUser.get(userId) ?? [])];
  }
}

export async function upsertPushSubscription(
  userId: string,
  input: Pick<PushSubscriptionRecord, 'endpoint' | 'keys'>,
): Promise<PushSubscriptionRecord> {
  const now = Math.floor(Date.now() / 1000);
  const subscription: PushSubscriptionRecord = {
    endpoint: input.endpoint,
    keys: input.keys,
    createdAtEpoch: now,
    updatedAtEpoch: now,
  };

  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    const memory = getMemoryStore();
    const current = [...(memory.pushSubscriptionsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.endpoint === input.endpoint);
    if (index >= 0) {
      current[index] = {
        ...current[index],
        keys: input.keys,
        updatedAtEpoch: now,
      };
      subscription.createdAtEpoch = current[index].createdAtEpoch;
      subscription.updatedAtEpoch = now;
    } else {
      current.push(subscription);
    }
    memory.pushSubscriptionsByUser.set(userId, current);
    return index >= 0 ? current[index] : subscription;
  }

  const client = getDocumentClient();
  const existingResponse = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: userPk(userId),
        SK: pushSubscriptionSk(input.endpoint),
      },
    }),
  );
  const existing = existingResponse.Item as PushSubscriptionItem | undefined;
  subscription.createdAtEpoch = existing?.created_at ?? now;

  const item: PushSubscriptionItem = {
    PK: userPk(userId),
    SK: pushSubscriptionSk(input.endpoint),
    entity_type: 'PUSH_SUBSCRIPTION',
    endpoint: input.endpoint,
    keys: input.keys,
    created_at: subscription.createdAtEpoch,
    updated_at: now,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    );
    return subscription;
  } catch (error) {
    if (!DEV_FALLBACK_ENABLED) {
      throw error;
    }
    const memory = getMemoryStore();
    const current = [...(memory.pushSubscriptionsByUser.get(userId) ?? [])];
    const index = current.findIndex((entry) => entry.endpoint === input.endpoint);
    if (index >= 0) {
      current[index] = {
        ...current[index],
        keys: input.keys,
        updatedAtEpoch: now,
      };
      memory.pushSubscriptionsByUser.set(userId, current);
      return current[index];
    }
    current.push(subscription);
    memory.pushSubscriptionsByUser.set(userId, current);
    return subscription;
  }
}

export async function deletePushSubscription(userId: string, endpoint: string): Promise<boolean> {
  if (!hasDynamoConfigured()) {
    if (!DEV_FALLBACK_ENABLED) {
      throw new Error('DynamoDB is required for notification persistence.');
    }
    const memory = getMemoryStore();
    const current = [...(memory.pushSubscriptionsByUser.get(userId) ?? [])];
    const next = current.filter((entry) => entry.endpoint !== endpoint);
    memory.pushSubscriptionsByUser.set(userId, next);
    return next.length !== current.length;
  }

  const client = getDocumentClient();
  try {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: userPk(userId),
          SK: pushSubscriptionSk(endpoint),
        },
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
      }),
    );
    return true;
  } catch {
    return false;
  }
}
