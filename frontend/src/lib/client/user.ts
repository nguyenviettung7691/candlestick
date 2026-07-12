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

const USER_ID_KEY = 'candlestick_user_id';

/**
 * Returns a stable per-browser user identifier stored in localStorage.
 * This replaces the previous server-side session cookie; personal data is now
 * scoped to the local browser only (no cross-device sync).
 */
export function getLocalUserId(): string {
  if (typeof window === 'undefined') {
    return 'server';
  }
  let userId = window.localStorage.getItem(USER_ID_KEY);
  if (!userId) {
    userId = `local_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    window.localStorage.setItem(USER_ID_KEY, userId);
  }
  return userId;
}
