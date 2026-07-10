from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlparse

from app import POLL_INTERVAL_SECONDS, _create_stock_engine, _fetch_live_data_with_history

try:
    from websockets.server import WebSocketServerProtocol, serve
except ImportError as exc:  # pragma: no cover - runtime dependency check
    raise RuntimeError(
        "Missing dependency 'websockets'. Install backend/lambda_polling/requirements-dev.txt before running local vnstock stream."
    ) from exc


LOGGER = logging.getLogger("local-vnstock-ws")

HOST = os.environ.get("LOCAL_VNSTOCK_WS_HOST", "0.0.0.0")
PORT = int(os.environ.get("LOCAL_VNSTOCK_WS_PORT", "8788"))
INTERVAL_SECONDS = max(int(os.environ.get("LOCAL_VNSTOCK_WS_INTERVAL_SECONDS", str(POLL_INTERVAL_SECONDS))), 1)

DEFAULT_DASHBOARD_SYMBOLS: dict[str, list[str]] = {
    "dash_01": ["FPT", "HPG", "VCB"],
    "banking": ["VCB", "FPT"],
    "steel": ["HPG"],
}


def _ensure_utf8_stdio() -> None:
    """Prevent Windows cp1252 stdout/stderr from crashing on Unicode logs."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                # Ignore streams that cannot be reconfigured (redirected or closed).
                continue


def _load_dashboard_symbols() -> dict[str, list[str]]:
    raw = os.environ.get("LOCAL_VNSTOCK_DASHBOARD_SYMBOLS_JSON", "").strip()
    if not raw:
        return DEFAULT_DASHBOARD_SYMBOLS

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        LOGGER.warning("Invalid LOCAL_VNSTOCK_DASHBOARD_SYMBOLS_JSON; using defaults")
        return DEFAULT_DASHBOARD_SYMBOLS

    if not isinstance(parsed, dict):
        return DEFAULT_DASHBOARD_SYMBOLS

    normalized: dict[str, list[str]] = {}
    for dashboard_id, symbols in parsed.items():
        if not isinstance(dashboard_id, str) or not isinstance(symbols, list):
            continue
        items = [str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()]
        if items:
            normalized[dashboard_id.strip() or "dash_01"] = sorted(set(items))

    return normalized or DEFAULT_DASHBOARD_SYMBOLS


def _symbols_for_dashboard(dashboard_id: str, dashboard_symbols: dict[str, list[str]]) -> list[str]:
    if dashboard_id in dashboard_symbols:
        return dashboard_symbols[dashboard_id]
    return dashboard_symbols.get("dash_01", [])


def _extract_dashboard_id(path: str | None) -> str:
    if not path:
        return "dash_01"
    parsed = urlparse(path)
    query = parse_qs(parsed.query)
    dashboard_id = str(query.get("dashboardId", ["dash_01"])[0]).strip()
    return dashboard_id or "dash_01"


def _build_packet(
    connection_id: str,
    dashboard_id: str,
    scoped_data: dict[str, dict[str, Any]],
    scoped_history: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    packet = {
        "dashboard_id": dashboard_id,
        "connection_id": connection_id,
        "as_of_epoch": int(time.time()),
        "data": scoped_data,
    }
    if scoped_history:
        packet["history"] = scoped_history
    return packet


async def _stream_client(websocket: WebSocketServerProtocol, dashboard_symbols: dict[str, list[str]]) -> None:
    dashboard_id = _extract_dashboard_id(websocket.path)
    symbols = _symbols_for_dashboard(dashboard_id, dashboard_symbols)
    connection_id = f"local_vn_{uuid.uuid4().hex[:8]}"

    if not symbols:
        await websocket.send(json.dumps(_build_packet(connection_id, dashboard_id, {}), separators=(",", ":")))
        return

    stock_engine = _create_stock_engine()

    while True:
        live_data, history_by_symbol = _fetch_live_data_with_history(symbols, stock_engine)
        scoped_data = {symbol: live_data[symbol] for symbol in symbols if symbol in live_data}
        scoped_history = {symbol: history_by_symbol[symbol] for symbol in symbols if symbol in history_by_symbol}
        packet = _build_packet(connection_id, dashboard_id, scoped_data, scoped_history)
        try:
            await websocket.send(json.dumps(packet, separators=(",", ":")))
        except Exception:
            return
        await asyncio.sleep(INTERVAL_SECONDS)


async def _main() -> None:
    dashboard_symbols = _load_dashboard_symbols()
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()

    def _request_shutdown() -> None:
        stop_event.set()

    if sys.platform != "win32":
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _request_shutdown)

    async with serve(lambda ws: _stream_client(ws, dashboard_symbols), HOST, PORT):
        LOGGER.info("local vnstock websocket running on ws://%s:%s", HOST, PORT)
        LOGGER.info("interval=%ss dashboards=%s", INTERVAL_SECONDS, ",".join(sorted(dashboard_symbols.keys())))
        await stop_event.wait()


if __name__ == "__main__":
    _ensure_utf8_stdio()
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
