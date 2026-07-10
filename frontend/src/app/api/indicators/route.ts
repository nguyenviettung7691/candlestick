import { NextRequest, NextResponse } from 'next/server';

import { createIndicator, listCustomIndicators } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

interface IndicatorWriteBody {
  name?: unknown;
  description?: unknown;
  params?: unknown;
}

function normalizeParams(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const params: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    params[key] = numeric;
  }
  return params;
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const indicators = await listCustomIndicators(session.userId);
    return NextResponse.json({ ok: true, items: indicators });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to list indicators' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: IndicatorWriteBody;
  try {
    body = (await request.json()) as IndicatorWriteBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const params = normalizeParams(body.params);

  if (!name || !params || Object.keys(params).length === 0) {
    return NextResponse.json(
      { ok: false, message: 'name and numeric params are required' },
      { status: 400 },
    );
  }

  try {
    const indicator = await createIndicator(session.userId, {
      name,
      description,
      params,
    });
    return NextResponse.json({ ok: true, item: indicator }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to create indicator' },
      { status: 500 },
    );
  }
}
