import { NextRequest, NextResponse } from 'next/server';

import { updateDashboard } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

interface DashboardPatchBody {
  name?: unknown;
  description?: unknown;
  indicatorId?: unknown;
  symbols?: unknown;
}

function normalizeSymbols(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry).trim().toUpperCase())
    .filter((entry) => entry.length > 0);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { dashboardId: string } },
) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  const dashboardId = String(params.dashboardId ?? '').trim();
  if (!dashboardId) {
    return NextResponse.json({ ok: false, message: 'dashboardId is required' }, { status: 400 });
  }

  let body: DashboardPatchBody;
  try {
    body = (await request.json()) as DashboardPatchBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const symbols = normalizeSymbols(body.symbols);
  if (symbols && symbols.length === 0) {
    return NextResponse.json({ ok: false, message: 'symbols must be a non-empty array' }, { status: 400 });
  }

  try {
    const updated = await updateDashboard(session.userId, dashboardId, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      description: typeof body.description === 'string' ? body.description.trim() : undefined,
      indicatorId: typeof body.indicatorId === 'string' ? body.indicatorId.trim() : undefined,
      symbols,
    });

    if (!updated) {
      return NextResponse.json({ ok: false, message: 'Dashboard not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to update dashboard' },
      { status: 500 },
    );
  }
}
