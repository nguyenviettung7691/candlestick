import { NextRequest, NextResponse } from 'next/server';

import { createNotificationRule, listNotificationRules } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

import { normalizeChannels, normalizeCondition } from './validation';

export const runtime = 'nodejs';

interface NotificationRuleWriteBody {
  name?: unknown;
  dashboardId?: unknown;
  symbol?: unknown;
  indicatorId?: unknown;
  condition?: unknown;
  channels?: unknown;
  cooldownSeconds?: unknown;
  enabled?: unknown;
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rules = await listNotificationRules(session.userId);
    return NextResponse.json({ ok: true, items: rules });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to list notification rules' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: NotificationRuleWriteBody;
  try {
    body = (await request.json()) as NotificationRuleWriteBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const dashboardId = typeof body.dashboardId === 'string' ? body.dashboardId.trim() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  const indicatorId = typeof body.indicatorId === 'string' ? body.indicatorId.trim() : '';
  const condition = normalizeCondition(body.condition);
  const channels = normalizeChannels(body.channels);
  const cooldownSeconds = Number(body.cooldownSeconds ?? 0);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  if (!name || !dashboardId || !symbol || !indicatorId || !condition || !channels || !Number.isFinite(cooldownSeconds)) {
    return NextResponse.json(
      {
        ok: false,
        message: 'name, dashboardId, symbol, indicatorId, condition, channels, and numeric cooldownSeconds are required',
      },
      { status: 400 },
    );
  }

  try {
    const rule = await createNotificationRule(session.userId, {
      name,
      dashboardId,
      symbol,
      indicatorId,
      condition,
      channels,
      cooldownSeconds: Math.max(Math.floor(cooldownSeconds), 0),
      enabled,
    });
    return NextResponse.json({ ok: true, item: rule }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to create notification rule' },
      { status: 500 },
    );
  }
}
