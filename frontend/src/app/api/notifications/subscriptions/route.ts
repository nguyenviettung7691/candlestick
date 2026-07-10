import { NextRequest, NextResponse } from 'next/server';

import { deletePushSubscription, listPushSubscriptions, upsertPushSubscription } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

interface PushSubscriptionBody {
  endpoint?: unknown;
  keys?: unknown;
}

function normalizeKeys(value: unknown): { p256dh: string; auth: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const keys = value as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  if (!p256dh || !auth) {
    return null;
  }

  return { p256dh, auth };
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const subscriptions = await listPushSubscriptions(session.userId);
    return NextResponse.json({ ok: true, items: subscriptions });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to list push subscriptions' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: PushSubscriptionBody;
  try {
    body = (await request.json()) as PushSubscriptionBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const keys = normalizeKeys(body.keys);
  if (!endpoint || !keys) {
    return NextResponse.json({ ok: false, message: 'endpoint and keys are required' }, { status: 400 });
  }

  try {
    const subscription = await upsertPushSubscription(session.userId, { endpoint, keys });
    return NextResponse.json({ ok: true, item: subscription }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to save push subscription' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: PushSubscriptionBody;
  try {
    body = (await request.json()) as PushSubscriptionBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) {
    return NextResponse.json({ ok: false, message: 'endpoint is required' }, { status: 400 });
  }

  try {
    const removed = await deletePushSubscription(session.userId, endpoint);
    if (!removed) {
      return NextResponse.json({ ok: false, message: 'Subscription not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to remove push subscription' },
      { status: 500 },
    );
  }
}
