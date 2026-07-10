import type { NextRequest } from 'next/server';

import { getSession } from '@/lib/server/persistence';

export interface SessionContext {
  token: string;
  userId: string;
}

export async function getSessionContext(request: NextRequest): Promise<SessionContext | null> {
  const token = request.cookies.get('candlestick_session')?.value ?? '';
  if (!token) {
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    return null;
  }

  return {
    token,
    userId: session.userId,
  };
}
