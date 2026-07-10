import { NextRequest, NextResponse } from 'next/server';

import { updateNotificationRule } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

import { normalizeChannels, normalizeCondition } from '../validation';

export const runtime = 'nodejs';

interface NotificationRulePatchBody {
  name?: unknown;
  dashboardId?: unknown;
  symbol?: unknown;
  indicatorId?: unknown;
  condition?: unknown;
  channels?: unknown;
  cooldownSeconds?: unknown;
  enabled?: unknown;
  lastTriggeredAtEpoch?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { ruleId: string } },
) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  const ruleId = String(params.ruleId ?? '').trim();
  if (!ruleId) {
    return NextResponse.json({ ok: false, message: 'ruleId is required' }, { status: 400 });
  }

  let body: NotificationRulePatchBody;
  try {
    body = (await request.json()) as NotificationRulePatchBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  let condition;
  if (body.condition !== undefined) {
    const normalizedCondition = normalizeCondition(body.condition);
    if (!normalizedCondition) {
      return NextResponse.json({ ok: false, message: 'condition is invalid' }, { status: 400 });
    }
    condition = normalizedCondition;
  }

  let channels;
  if (body.channels !== undefined) {
    const normalizedChannels = normalizeChannels(body.channels);
    if (!normalizedChannels) {
      return NextResponse.json({ ok: false, message: 'channels is invalid' }, { status: 400 });
    }
    channels = normalizedChannels;
  }

  const parsedCooldown = body.cooldownSeconds === undefined ? undefined : Number(body.cooldownSeconds);
  if (parsedCooldown !== undefined && !Number.isFinite(parsedCooldown)) {
    return NextResponse.json({ ok: false, message: 'cooldownSeconds must be numeric' }, { status: 400 });
  }

  const parsedLastTriggeredAt =
    body.lastTriggeredAtEpoch === undefined ? undefined : Number(body.lastTriggeredAtEpoch);
  if (parsedLastTriggeredAt !== undefined && !Number.isFinite(parsedLastTriggeredAt)) {
    return NextResponse.json({ ok: false, message: 'lastTriggeredAtEpoch must be numeric' }, { status: 400 });
  }

  try {
    const updated = await updateNotificationRule(session.userId, ruleId, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      dashboardId: typeof body.dashboardId === 'string' ? body.dashboardId.trim() : undefined,
      symbol: typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : undefined,
      indicatorId: typeof body.indicatorId === 'string' ? body.indicatorId.trim() : undefined,
      condition,
      channels,
      cooldownSeconds: parsedCooldown === undefined ? undefined : Math.max(Math.floor(parsedCooldown), 0),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      lastTriggeredAtEpoch: parsedLastTriggeredAt === undefined ? undefined : Math.floor(parsedLastTriggeredAt),
    });

    if (!updated) {
      return NextResponse.json({ ok: false, message: 'Notification rule not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to update notification rule' },
      { status: 500 },
    );
  }
}
