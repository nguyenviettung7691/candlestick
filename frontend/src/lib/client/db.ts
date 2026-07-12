import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type {
  DashboardDefinition,
  IndicatorDefinition,
  NotificationEvent,
  NotificationRule,
  PushSubscriptionRecord,
} from '@/lib/types';

export const DB_NAME = 'candlestick';
export const DB_VERSION = 1;

export const STORE_DASHBOARDS = 'dashboards';
export const STORE_INDICATORS = 'indicators';
export const STORE_NOTIFICATION_RULES = 'notificationRules';
export const STORE_NOTIFICATION_EVENTS = 'notificationEvents';
export const STORE_PUSH_SUBSCRIPTIONS = 'pushSubscriptions';

export type StoreName =
  | 'dashboards'
  | 'indicators'
  | 'notificationRules'
  | 'notificationEvents'
  | 'pushSubscriptions';

interface CandlestickDB extends DBSchema {
  dashboards: {
    key: string;
    value: DashboardDefinition;
  };
  indicators: {
    key: string;
    value: IndicatorDefinition;
  };
  notificationRules: {
    key: string;
    value: NotificationRule;
  };
  notificationEvents: {
    key: string;
    value: NotificationEvent;
  };
  pushSubscriptions: {
    key: string;
    value: PushSubscriptionRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<CandlestickDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<CandlestickDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CandlestickDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_DASHBOARDS)) {
          database.createObjectStore(STORE_DASHBOARDS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_INDICATORS)) {
          database.createObjectStore(STORE_INDICATORS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_NOTIFICATION_RULES)) {
          database.createObjectStore(STORE_NOTIFICATION_RULES, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_NOTIFICATION_EVENTS)) {
          database.createObjectStore(STORE_NOTIFICATION_EVENTS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_PUSH_SUBSCRIPTIONS)) {
          database.createObjectStore(STORE_PUSH_SUBSCRIPTIONS, { keyPath: 'endpoint' });
        }
      },
    });
  }
  return dbPromise;
}

export async function getAllFromStore<T>(store: StoreName): Promise<T[]> {
  const db = await getDb();
  return db.getAll(store) as Promise<T[]>;
}

export async function putInStore<T>(store: StoreName, value: T): Promise<void> {
  const db = await getDb();
  await db.put(store, value as never);
}

export async function deleteFromStore(store: StoreName, key: string): Promise<void> {
  const db = await getDb();
  await db.delete(store, key);
}
