import { NextRequest, NextResponse } from 'next/server';

import { createNotificationEvent, listNotificationEvents } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

import { normalizeChannels } from '../validation';

export const runtime = 'nodejs';

interface NotificationEventWriteBody {
  ruleId?: unknown;
  dashboardId?: unknown;
  symbol?: unknown;
  message?: unknown;
  channels?: unknown;
  triggeredAtEpoch?: unknown;
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.floor(limitParam), 1), 200) : 50;

  try {
    const events = await listNotificationEvents(session.userId, limit);
    return NextResponse.json({ ok: true, items: events });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to list notification events' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: NotificationEventWriteBody;
  try {
    body = (await request.json()) as NotificationEventWriteBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const ruleId = typeof body.ruleId === 'string' ? body.ruleId.trim() : '';
  const dashboardId = typeof body.dashboardId === 'string' ? body.dashboardId.trim() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const channels = normalizeChannels(body.channels);
  const triggeredAtEpoch = body.triggeredAtEpoch === undefined ? undefined : Number(body.triggeredAtEpoch);

  if (!ruleId || !dashboardId || !symbol || !message || !channels) {
    return NextResponse.json(
      { ok: false, message: 'ruleId, dashboardId, symbol, message, and channels are required' },
      { status: 400 },
    );
  }

  if (triggeredAtEpoch !== undefined && !Number.isFinite(triggeredAtEpoch)) {
    return NextResponse.json({ ok: false, message: 'triggeredAtEpoch must be numeric' }, { status: 400 });
  }

  try {
    const event = await createNotificationEvent(session.userId, {
      ruleId,
      dashboardId,
      symbol,
      message,
      channels,
      triggeredAtEpoch: triggeredAtEpoch === undefined ? undefined : Math.floor(triggeredAtEpoch),
    });
    return NextResponse.json({ ok: true, item: event }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to create notification event' },
      { status: 500 },
    );
  }
}
