import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';

import type { SymbolCatalogItem } from '@/lib/types';
import { getSessionContext } from '@/lib/server/session';

export const runtime = 'nodejs';

const DEFAULT_SYMBOL_CATALOG: SymbolCatalogItem[] = [
  { symbol: 'FPT', companyName: 'FPT Corporation', exchange: 'HOSE' },
  { symbol: 'HPG', companyName: 'Hoa Phat Group', exchange: 'HOSE' },
  { symbol: 'VCB', companyName: 'Joint Stock Commercial Bank for Foreign Trade of Vietnam', exchange: 'HOSE' },
];

const VNSTOCK_SYMBOLS_TIMEOUT_MS = Number.parseInt(process.env.VNSTOCK_SYMBOLS_TIMEOUT_MS ?? '45000', 10);
const SYMBOLS_CACHE_TTL_SECONDS = Number.parseInt(process.env.SYMBOLS_CACHE_TTL_SECONDS ?? '3600', 10);

let cachedSymbols: {
  expiresAtEpoch: number;
  source: 'vnstock';
  items: SymbolCatalogItem[];
} | null = null;

function normalizeSymbol(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase();
}

function normalizeCatalogEntry(input: unknown): SymbolCatalogItem | null {
  if (typeof input === 'string') {
    const symbol = normalizeSymbol(input);
    if (!symbol) {
      return null;
    }
    return {
      symbol,
      companyName: symbol,
    };
  }

  if (!input || typeof input !== 'object') {
    return null;
  }

  const entry = input as Record<string, unknown>;
  const symbol = normalizeSymbol(entry.symbol ?? entry.ticker ?? entry.code ?? entry.id);
  if (!symbol) {
    return null;
  }

  const companyNameCandidate = entry.company_name ?? entry.companyName ?? entry.short_name ?? entry.organ_name ?? entry.name;
  const exchangeCandidate = entry.exchange ?? entry.market ?? entry.board;

  const companyName = String(companyNameCandidate ?? symbol).trim() || symbol;
  const exchange = String(exchangeCandidate ?? '').trim().toUpperCase();

  return {
    symbol,
    companyName,
    exchange: exchange || undefined,
  };
}

function normalizeCatalogPayload(payload: unknown): SymbolCatalogItem[] {
  const rawItems = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).items ?? (payload as Record<string, unknown>).data)
      : [];

  if (!Array.isArray(rawItems)) {
    return [];
  }

  const bySymbol = new Map<string, SymbolCatalogItem>();
  for (const rawItem of rawItems) {
    const normalized = normalizeCatalogEntry(rawItem);
    if (!normalized) {
      continue;
    }

    const existing = bySymbol.get(normalized.symbol);
    if (!existing || existing.companyName === existing.symbol) {
      bySymbol.set(normalized.symbol, normalized);
    }
  }

  return Array.from(bySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function pythonCandidates(): string[] {
  const configured = [process.env.VNSTOCK_PYTHON_BIN, process.env.PYTHON_BIN]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
  return [...new Set([...configured, 'python', 'py', 'python3'])];
}

function runPythonJson(pythonBin: string, script: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-c', script], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const effectiveTimeout = Number.isFinite(timeoutMs) ? Math.max(timeoutMs, 1000) : 15000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, effectiveTimeout);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`VNStock symbol fetch timed out with ${pythonBin}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Python exited with code ${String(code)}`));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        resolve([]);
        return;
      }

      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index];
        if (!(candidate.startsWith('{') || candidate.startsWith('['))) {
          continue;
        }

        try {
          resolve(JSON.parse(candidate) as unknown);
          return;
        } catch {
          continue;
        }
      }

      reject(new Error(`Invalid JSON from Python: ${output.slice(0, 240)}`));
    });
  });
}

async function fetchVnstockCatalog(): Promise<SymbolCatalogItem[]> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (cachedSymbols && cachedSymbols.expiresAtEpoch > nowEpoch) {
    return cachedSymbols.items;
  }

  const script = `
import json
import os
import sys

def _to_records(payload):
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("items"), list):
            return payload["items"]
        if isinstance(payload.get("data"), list):
            return payload["data"]
        return [payload]
    if hasattr(payload, "to_dict"):
        return payload.to_dict(orient="records")
    return []

try:
    try:
        from vnstock import Reference
    except Exception:
        from vnstock.ui import Reference

    try:
        from vnstock import register_user
        api_key = os.getenv("VNSTOCK_API_KEY", "").strip()
        if api_key:
            try:
                register_user(api_key=api_key)
            except Exception:
                pass
    except Exception:
        pass

    ref = Reference()
    equity_attr = getattr(ref, "equity", None)
    equity_obj = equity_attr() if callable(equity_attr) else equity_attr
    if equity_obj is None:
        raise RuntimeError("Reference.equity is unavailable")

    list_method = getattr(equity_obj, "list", None)
    if not callable(list_method):
        raise RuntimeError("Reference.equity.list() is unavailable")

    result = list_method()
    records = _to_records(result)
    print(json.dumps(records, ensure_ascii=True))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(1)
`;

  for (const candidate of pythonCandidates()) {
    try {
      const payload = await runPythonJson(candidate, script, VNSTOCK_SYMBOLS_TIMEOUT_MS);
      const items = normalizeCatalogPayload(payload);
      if (items.length > 0) {
        cachedSymbols = {
          expiresAtEpoch: nowEpoch + Math.max(SYMBOLS_CACHE_TTL_SECONDS, 60),
          source: 'vnstock',
          items,
        };
        return items;
      }
    } catch {
      continue;
    }
  }

  return [];
}

async function fetchProviderCatalog(): Promise<SymbolCatalogItem[]> {
  const providerUrl = process.env.SYMBOLS_API_URL;
  if (!providerUrl) {
    return [];
  }

  const timeoutMs = Number.parseInt(process.env.SYMBOLS_API_TIMEOUT_MS ?? '5000', 10);
  const authHeader = process.env.SYMBOLS_API_AUTH_HEADER;
  const authToken = process.env.SYMBOLS_API_AUTH_TOKEN;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? Math.max(timeoutMs, 1000) : 5000);

  try {
    const headers = new Headers({
      accept: 'application/json',
    });
    if (authHeader && authToken) {
      headers.set(authHeader, authToken);
    }

    const response = await fetch(providerUrl, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as unknown;
    return normalizeCatalogPayload(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function GET(request: NextRequest) {
  const session = await getSessionContext(request);
  if (!session) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }

  const providerItems = await fetchProviderCatalog();
  if (providerItems.length > 0) {
    return NextResponse.json({
      ok: true,
      source: 'provider',
      items: providerItems,
    });
  }

  const vnstockItems = await fetchVnstockCatalog();
  if (vnstockItems.length > 0) {
    return NextResponse.json({
      ok: true,
      source: 'vnstock',
      items: vnstockItems,
    });
  }

  return NextResponse.json({
    ok: true,
    source: 'fallback',
    items: DEFAULT_SYMBOL_CATALOG,
  });
}
