from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import threading
import time
import uuid
from collections import deque
from datetime import date, timedelta
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse

import pandas as pd

from indicators import calculate_atrm, calculate_ls_dvp, calculate_mr_zsb, calculate_mtf_scoring

try:
    from websockets.server import WebSocketServerProtocol, serve
except ImportError as exc:  # pragma: no cover - runtime dependency check
    raise RuntimeError(
        "Missing dependency 'websockets'. Install frontend/scripts/requirements-dev.txt before running local vnstock stream."
    ) from exc


LOGGER = logging.getLogger("local-vnstock-ws")

HOST = os.environ.get("LOCAL_VNSTOCK_WS_HOST", "0.0.0.0")
PORT = int(os.environ.get("LOCAL_VNSTOCK_WS_PORT", "8788"))

# --- Inlined configuration + vnstock helpers (previously in backend/lambda_polling/app.py) ---
# These are the only pieces of the old AWS Lambda module required to stream live
# market data locally. All DynamoDB / API Gateway / web-push code has been removed.


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        LOGGER.warning("Invalid integer value for %s=%r; using default=%s", name, value, default)
        return default
    return max(parsed, minimum)


POLL_INTERVAL_SECONDS = _env_int("POLL_INTERVAL_SECONDS", 10)
PRICE_HISTORY_SIZE = _env_int("PRICE_HISTORY_SIZE", 100, minimum=30)
MIN_UI_HISTORY_BARS = _env_int("MIN_UI_HISTORY_BARS", 65, minimum=65)
STOCK_DATA_SOURCE = os.environ.get("STOCK_DATA_SOURCE", "VCI")
VNSTOCK_API_KEY = os.environ.get("VNSTOCK_API_KEY", "").strip()
VNSTOCK_MAX_REQUESTS_PER_MINUTE = _env_int("VNSTOCK_MAX_REQUESTS_PER_MINUTE", 60)
VNSTOCK_MAX_REQUESTS_PER_HOUR = _env_int("VNSTOCK_MAX_REQUESTS_PER_HOUR", 3600)
VNSTOCK_MAX_REQUESTS_PER_DAY = _env_int("VNSTOCK_MAX_REQUESTS_PER_DAY", 10000)
VNSTOCK_MAX_REQUESTS_PER_MONTH = _env_int("VNSTOCK_MAX_REQUESTS_PER_MONTH", 100000)


class _VnstockRateLimiter:
    def __init__(
        self,
        *,
        per_minute: int,
        per_hour: int,
        per_day: int,
        per_month: int,
        time_func=time.monotonic,
        sleep_func=time.sleep,
    ) -> None:
        self._per_minute = max(int(per_minute), 1)
        self._per_hour = max(int(per_hour), 1)
        self._per_day = max(int(per_day), 1)
        self._per_month = max(int(per_month), 1)
        self._time = time_func
        self._sleep = sleep_func
        self._minute_window = 60.0
        self._hour_window = 3600.0
        self._day_window = 86_400.0
        # Use rolling 30-day window for stable monthly throttling.
        self._month_window = 30 * 86_400.0
        self._minute_timestamps: deque[float] = deque()
        self._hour_timestamps: deque[float] = deque()
        self._day_timestamps: deque[float] = deque()
        self._month_timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        while self._minute_timestamps and now - self._minute_timestamps[0] >= self._minute_window:
            self._minute_timestamps.popleft()
        while self._hour_timestamps and now - self._hour_timestamps[0] >= self._hour_window:
            self._hour_timestamps.popleft()
        while self._day_timestamps and now - self._day_timestamps[0] >= self._day_window:
            self._day_timestamps.popleft()
        while self._month_timestamps and now - self._month_timestamps[0] >= self._month_window:
            self._month_timestamps.popleft()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = self._time()
                self._prune(now)

                minute_available = len(self._minute_timestamps) < self._per_minute
                hour_available = len(self._hour_timestamps) < self._per_hour
                day_available = len(self._day_timestamps) < self._per_day
                month_available = len(self._month_timestamps) < self._per_month
                if minute_available and hour_available and day_available and month_available:
                    self._minute_timestamps.append(now)
                    self._hour_timestamps.append(now)
                    self._day_timestamps.append(now)
                    self._month_timestamps.append(now)
                    return

                wait_seconds: list[float] = []
                if not minute_available and self._minute_timestamps:
                    wait_seconds.append(self._minute_timestamps[0] + self._minute_window - now)
                if not hour_available and self._hour_timestamps:
                    wait_seconds.append(self._hour_timestamps[0] + self._hour_window - now)
                if not day_available and self._day_timestamps:
                    wait_seconds.append(self._day_timestamps[0] + self._day_window - now)
                if not month_available and self._month_timestamps:
                    wait_seconds.append(self._month_timestamps[0] + self._month_window - now)

            sleep_for = max(min(wait_seconds) if wait_seconds else 0.01, 0.01)
            LOGGER.info(
                "vnstock request limit reached (%s/min, %s/hour, %s/day, %s/month). Sleeping %.2fs",
                self._per_minute,
                self._per_hour,
                self._per_day,
                self._per_month,
                sleep_for,
            )
            self._sleep(sleep_for)


VNSTOCK_RATE_LIMITER = _VnstockRateLimiter(
    per_minute=VNSTOCK_MAX_REQUESTS_PER_MINUTE,
    per_hour=VNSTOCK_MAX_REQUESTS_PER_HOUR,
    per_day=VNSTOCK_MAX_REQUESTS_PER_DAY,
    per_month=VNSTOCK_MAX_REQUESTS_PER_MONTH,
)


def _register_vnstock_api_key() -> None:
    if not VNSTOCK_API_KEY:
        return

    try:
        from vnstock import register_user
    except Exception:
        LOGGER.debug("vnstock register_user is unavailable; skipping API key registration")
        return

    try:
        register_user(api_key=VNSTOCK_API_KEY)
    except Exception as exc:
        LOGGER.warning("vnstock API key registration failed: %s", exc)


def _create_stock_engine() -> Any:
    _register_vnstock_api_key()

    try:
        from vnstock import Market

        return {
            "mode": "unified_ui_market",
            "market_class": Market,
        }
    except Exception:
        try:
            from vnstock.ui import Market

            return {
                "mode": "unified_ui_market",
                "market_class": Market,
            }
        except Exception:
            pass

    try:
        from vnstock.api.quote import Quote

        return {
            "mode": "quote_api",
            "quote_class": Quote,
        }
    except Exception:
        # Backward-compatible fallback for older vnstock package variants.
        from vnstock import Vnstock

        return Vnstock()


def _history_date_window() -> tuple[str, str]:
    end_date = date.today()
    # Use a wider calendar window so we still get enough trading candles after weekends/holidays.
    start_date = end_date - timedelta(days=max(PRICE_HISTORY_SIZE * 3, 90))
    return start_date.isoformat(), end_date.isoformat()


def _call_market_ohlcv_method(ohlcv_method: Any, *, ticker: str) -> pd.DataFrame:
    start, end = _history_date_window()

    attempts = (
        {
            "start": start,
            "end": end,
            "interval": "1D",
        },
        {
            "start": start,
            "end": end,
            "interval": "1D",
            "count": PRICE_HISTORY_SIZE,
        },
        {
            "count": PRICE_HISTORY_SIZE,
            "interval": "1D",
        },
    )

    last_exc: Exception | None = None
    for kwargs in attempts:
        try:
            VNSTOCK_RATE_LIMITER.acquire()
            frame = ohlcv_method(**kwargs)
            if frame is None:
                return frame
            if getattr(frame, "empty", False):
                return frame
            return frame.copy()
        except TypeError as exc:
            last_exc = exc
            continue

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Unable to call ohlcv method")


def _call_quote_history_method(history_method: Any, *, ticker: str) -> pd.DataFrame:
    start, end = _history_date_window()

    attempts = (
        {
            "symbol": ticker,
            "start": start,
            "end": end,
            "interval": "1D",
        },
        {
            "start": start,
            "end": end,
            "interval": "1D",
        },
        {
            "symbol": ticker,
            "interval": "1D",
            "count": PRICE_HISTORY_SIZE,
        },
        {
            "interval": "1D",
            "count": PRICE_HISTORY_SIZE,
        },
    )

    last_exc: Exception | None = None
    for kwargs in attempts:
        try:
            VNSTOCK_RATE_LIMITER.acquire()
            frame = history_method(**kwargs)
            if frame is None:
                return frame
            if getattr(frame, "empty", False):
                return frame
            return frame.copy()
        except TypeError as exc:
            last_exc = exc
            continue

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Unable to call history method")


def _call_legacy_history_method(history_method: Any, *, ticker: str) -> pd.DataFrame:
    start, end = _history_date_window()

    attempts = (
        {
            "symbol": ticker,
            "start": start,
            "end": end,
            "interval": "1D",
        },
        {
            "start": start,
            "end": end,
            "interval": "1D",
        },
        {"period": "1D", "size": PRICE_HISTORY_SIZE},
        {"symbol": ticker, "period": "1D", "size": PRICE_HISTORY_SIZE},
    )

    last_exc: Exception | None = None
    for kwargs in attempts:
        try:
            VNSTOCK_RATE_LIMITER.acquire()
            frame = history_method(**kwargs)
            if frame is None:
                return frame
            if getattr(frame, "empty", False):
                return frame
            return frame.copy()
        except TypeError as exc:
            last_exc = exc
            continue

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Unable to call history method")


def _normalize_ohlcv_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df is None:
        return df
    if not isinstance(df, pd.DataFrame):
        raise TypeError("history payload must be a pandas DataFrame")
    if df.empty:
        return df.copy()

    frame = df.copy()

    normalized_columns: dict[str, str] = {}
    for original in frame.columns:
        key = str(original).strip().lower().replace(" ", "_")
        normalized_columns[original] = key
    frame = frame.rename(columns=normalized_columns)

    column_aliases = {
        "datetime": "time",
        "date": "time",
        "trading_date": "time",
        "timestamp": "time",
        "vol": "volume",
        "total_volume": "volume",
    }
    frame = frame.rename(columns={name: alias for name, alias in column_aliases.items() if name in frame.columns})

    if "time" not in frame.columns:
        if isinstance(frame.index, pd.DatetimeIndex):
            frame = frame.reset_index()
            index_name = str(frame.columns[0]).strip().lower()
            if index_name in {"index", "date", "datetime", "timestamp", "trading_date", "time"}:
                frame = frame.rename(columns={frame.columns[0]: "time"})
        elif isinstance(frame.index, pd.Index) and frame.index.name:
            index_name = str(frame.index.name).strip().lower()
            if index_name in {"date", "datetime", "timestamp", "trading_date", "time"}:
                frame = frame.reset_index().rename(columns={frame.index.name: "time"})

    if "time" in frame.columns:
        frame["time"] = pd.to_datetime(frame["time"], errors="coerce")
        frame = frame.dropna(subset=["time"]).sort_values("time")

    required_columns = {"open", "high", "low", "close", "volume"}
    missing = required_columns.difference(frame.columns)
    if missing:
        raise ValueError(f"history payload missing OHLCV columns: {sorted(missing)}")

    for column in required_columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    frame = frame.dropna(subset=["open", "high", "low", "close", "volume"])
    return frame.copy()


def _fetch_history_frame(stock_engine: Any, ticker: str) -> pd.DataFrame:
    if isinstance(stock_engine, dict) and stock_engine.get("mode") == "unified_ui_market":
        market_class = stock_engine.get("market_class")
        if market_class is None:
            raise RuntimeError("unified_ui_market mode is missing market_class")

        market = market_class()
        equity_accessor = market.equity(symbol=ticker)
        frame = _call_market_ohlcv_method(equity_accessor.ohlcv, ticker=ticker)
        return _normalize_ohlcv_frame(frame)

    if isinstance(stock_engine, dict) and stock_engine.get("mode") == "quote_api":
        quote_class = stock_engine.get("quote_class")
        if quote_class is None:
            raise RuntimeError("quote_api mode is missing quote_class")
        quote = quote_class(symbol=ticker, source=STOCK_DATA_SOURCE, show_log=False)
        frame = _call_quote_history_method(quote.history, ticker=ticker)
        return _normalize_ohlcv_frame(frame)

    if hasattr(stock_engine, "stock"):
        market = stock_engine.stock(symbol=ticker, source=STOCK_DATA_SOURCE)

        quote = getattr(market, "quote", None)
        if quote is not None and hasattr(quote, "history"):
            frame = _call_quote_history_method(quote.history, ticker=ticker)
            return _normalize_ohlcv_frame(frame)

        trading = getattr(market, "trading", None)
        if trading is not None and hasattr(trading, "history"):
            frame = _call_legacy_history_method(trading.history, ticker=ticker)
            return _normalize_ohlcv_frame(frame)

        if hasattr(market, "history"):
            frame = _call_legacy_history_method(market.history, ticker=ticker)
            return _normalize_ohlcv_frame(frame)

        raise AttributeError("No supported history method found on vnstock market object")

    if hasattr(stock_engine, "history"):
        frame = _call_legacy_history_method(stock_engine.history, ticker=ticker)
        return _normalize_ohlcv_frame(frame)

    raise TypeError("Unsupported stock engine type")


def _resample_frame(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    time_column = None
    for candidate in ("time", "date", "datetime", "timestamp", "trading_date"):
        if candidate in df.columns:
            time_column = candidate
            break

    if time_column is None:
        return df.copy()

    indexed = df.copy()
    indexed[time_column] = pd.to_datetime(indexed[time_column], errors="coerce")
    indexed = indexed.dropna(subset=[time_column]).set_index(time_column)
    if indexed.empty:
        return df.copy()
    try:
        aggregated = indexed.resample(rule).last().dropna(how="all")
    except ValueError:
        # pandas>=3 rejects alias "M" in favor of "ME".
        fallback_rule = "ME" if rule == "M" else rule
        aggregated = indexed.resample(fallback_rule).last().dropna(how="all")
    aggregated = aggregated.reset_index()
    return aggregated if not aggregated.empty else df.copy()


def _build_live_packet(ticker: str, df_1d: pd.DataFrame) -> dict[str, Any]:
    indicator_frame = df_1d.tail(PRICE_HISTORY_SIZE).copy()
    df_1w = _resample_frame(indicator_frame, "W")
    df_1m = _resample_frame(indicator_frame, "M")
    latest_price = float(indicator_frame["close"].iloc[-1])

    mtf = calculate_mtf_scoring(indicator_frame, df_1w, df_1m, {})
    ls_dvp = calculate_ls_dvp(indicator_frame, {})
    zsb = calculate_mr_zsb(indicator_frame, {})
    atrm = calculate_atrm(indicator_frame, {})

    return {
        "symbol": ticker,
        "price": latest_price,
        "mtf_score": mtf["metric"],
        "mtf_signal": mtf["signal"],
        "ls_ratio": ls_dvp["metric"],
        "ls_signal": ls_dvp["signal"],
        "z_score": zsb["metric"],
        "z_signal": zsb["signal"],
        "trend_delta": atrm["metric"],
        "trend_signal": atrm["signal"],
    }


def _serialize_history_bars(df_1d: pd.DataFrame) -> list[dict[str, Any]]:
    if "time" not in df_1d.columns or df_1d.empty:
        return []

    history_size = max(PRICE_HISTORY_SIZE, MIN_UI_HISTORY_BARS)
    window = df_1d.tail(history_size).copy()
    window["time"] = pd.to_datetime(window["time"], errors="coerce")
    window = window.dropna(subset=["time", "open", "high", "low", "close"]).sort_values("time")
    if window.empty:
        return []

    bars: list[dict[str, Any]] = []
    for _, row in window.iterrows():
        bars.append(
            {
                "time": int(row["time"].timestamp()),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
            }
        )
    return bars


def _fetch_live_data_with_history(
    tickers: Iterable[str], stock_engine: Any
) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    live_data: dict[str, dict[str, Any]] = {}
    history_by_symbol: dict[str, list[dict[str, Any]]] = {}
    for ticker in tickers:
        try:
            df_1d = _fetch_history_frame(stock_engine, ticker)
            if df_1d is None or getattr(df_1d, "empty", True):
                continue
            live_data[ticker] = _build_live_packet(ticker, df_1d)
            history_by_symbol[ticker] = _serialize_history_bars(df_1d)
        except Exception as exc:  # noqa: BLE001 - continue processing other symbols
            LOGGER.warning("Failed to fetch/build packet for %s: %s", ticker, exc)
    return live_data, history_by_symbol


# --- Local WebSocket stream (unchanged behavior from the original local_ws_stream.py) ---

INTERVAL_SECONDS = max(int(os.environ.get("LOCAL_VNSTOCK_WS_INTERVAL_SECONDS", str(POLL_INTERVAL_SECONDS))), 1)

DEFAULT_DASHBOARD_SYMBOLS: dict[str, list[str]] = {}


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
            normalized[dashboard_id.strip()] = sorted(set(items))

    return normalized


def _symbols_for_dashboard(dashboard_id: str, dashboard_symbols: dict[str, list[str]]) -> list[str]:
    return dashboard_symbols.get(dashboard_id, [])


def _extract_dashboard_id(path: str | None) -> str:
    if not path:
        return ""
    parsed = urlparse(path)
    query = parse_qs(parsed.query)
    dashboard_id = str(query.get("dashboardId", [""])[0]).strip()
    return dashboard_id


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


def _normalize_symbols(incoming: list[str]) -> list[str]:
    """Normalize an inbound symbol list (uppercase, trimmed, de-duplicated).

    Used when the dashboard UI re-subscribes with a new symbol set. The server
    REPLACES its per-connection symbol set with this list rather than merging
    additively, so symbols removed from the dashboard stop streaming immediately.
    """
    return sorted({str(symbol).strip().upper() for symbol in incoming if str(symbol).strip()})


async def _stream_client(websocket: WebSocketServerProtocol, dashboard_symbols: dict[str, list[str]]) -> None:
    dashboard_id = _extract_dashboard_id(websocket.path)
    # Per-connection symbol set. Starts from the env-var map (if any) and is
    # kept up to date by inbound "symbols" messages from the dashboard UI,
    # which is the only place that knows the selected dashboard's symbols in
    # local mode (the Python process cannot reach the frontend store or DDB).
    symbols = list(_symbols_for_dashboard(dashboard_id, dashboard_symbols))
    connection_id = f"local_vn_{uuid.uuid4().hex[:8]}"

    stock_engine = None
    recv_task = asyncio.ensure_future(websocket.recv())
    try:
        while True:
            if symbols:
                if stock_engine is None:
                    stock_engine = _create_stock_engine()
                live_data, history_by_symbol = _fetch_live_data_with_history(symbols, stock_engine)
                scoped_data = {symbol: live_data[symbol] for symbol in symbols if symbol in live_data}
                scoped_history = {symbol: history_by_symbol[symbol] for symbol in symbols if symbol in history_by_symbol}
            else:
                scoped_data = {}
                scoped_history = None

            packet = _build_packet(connection_id, dashboard_id, scoped_data, scoped_history)
            try:
                await websocket.send(json.dumps(packet, separators=(",", ":")))
            except Exception:
                return

            done, _ = await asyncio.wait({recv_task}, timeout=INTERVAL_SECONDS)
            if recv_task in done:
                try:
                    message = json.loads(recv_task.result())
                except Exception:
                    message = None
                recv_task = asyncio.ensure_future(websocket.recv())
                if isinstance(message, dict):
                    incoming = message.get("symbols")
                    if isinstance(incoming, list):
                        symbols = _normalize_symbols([str(s) for s in incoming])
                        LOGGER.info("updated symbols for %s: %s", dashboard_id, ",".join(symbols))
    finally:
        recv_task.cancel()


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
