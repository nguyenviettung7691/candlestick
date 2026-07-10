import { NextRequest, NextResponse } from 'next/server';

import { updateIndicator } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

interface IndicatorPatchBody {
  name?: unknown;
  description?: unknown;
  params?: unknown;
}

function normalizeParams(value: unknown): Record<string, number> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: { indicatorId: string } },
) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  const indicatorId = String(params.indicatorId ?? '').trim();
  if (!indicatorId) {
    return NextResponse.json({ ok: false, message: 'indicatorId is required' }, { status: 400 });
  }

  let body: IndicatorPatchBody;
  try {
    body = (await request.json()) as IndicatorPatchBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const normalizedParams = normalizeParams(body.params);
  if (normalizedParams === null) {
    return NextResponse.json({ ok: false, message: 'params must be numeric' }, { status: 400 });
  }

  try {
    const updated = await updateIndicator(session.userId, indicatorId, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      description: typeof body.description === 'string' ? body.description.trim() : undefined,
      params: normalizedParams,
    });

    if (!updated) {
      return NextResponse.json({ ok: false, message: 'Indicator not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to update indicator' },
      { status: 500 },
    );
  }
}
