import { NextRequest, NextResponse } from 'next/server';

import { createDashboard, listDashboards } from '@/lib/server/persistence';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

interface DashboardWriteBody {
  name?: unknown;
  description?: unknown;
  indicatorId?: unknown;
  symbols?: unknown;
}

function normalizeSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry).trim().toUpperCase())
    .filter((entry) => entry.length > 0);
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const dashboards = await listDashboards(session.userId);
    return NextResponse.json({ ok: true, items: dashboards });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to list dashboards' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  let body: DashboardWriteBody;
  try {
    body = (await request.json()) as DashboardWriteBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const indicatorId = typeof body.indicatorId === 'string' ? body.indicatorId.trim() : '';
  const symbols = normalizeSymbols(body.symbols);

  if (!name || !indicatorId || symbols.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'name, indicatorId, and symbols are required' },
      { status: 400 },
    );
  }

  try {
    const dashboard = await createDashboard(session.userId, {
      name,
      description,
      indicatorId,
      symbols,
    });
    return NextResponse.json({ ok: true, item: dashboard }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Failed to create dashboard' },
      { status: 500 },
    );
  }
}
