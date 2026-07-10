from __future__ import annotations

import asyncio
from datetime import date, timedelta
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Iterable

import boto3
import pandas as pd
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import BotoCoreError, ClientError

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # pragma: no cover - optional during local tests
    WebPushException = None
    webpush = None

from indicators import calculate_atrm, calculate_ls_dvp, calculate_mr_zsb, calculate_mtf_scoring


LOGGER = logging.getLogger(__name__)


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


DYNAMO_TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME", "CandlestickDashboardTable")
WEBSOCKET_ENDPOINT = os.environ.get("WEBSOCKET_API_ENDPOINT", "")
POLL_INTERVAL_SECONDS = _env_int("POLL_INTERVAL_SECONDS", 10)
MAX_RUNTIME_SECONDS = _env_int("MAX_RUNTIME_SECONDS", 52)
PRICE_HISTORY_SIZE = _env_int("PRICE_HISTORY_SIZE", 100, minimum=30)
MIN_UI_HISTORY_BARS = _env_int("MIN_UI_HISTORY_BARS", 65, minimum=65)
NO_TARGET_RETRY_SECONDS = _env_int("NO_TARGET_RETRY_SECONDS", 1)
STOCK_DATA_SOURCE = os.environ.get("STOCK_DATA_SOURCE", "VCI")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "")
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


AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(DYNAMO_TABLE_NAME)
apigw_client = None


@dataclass(frozen=True)
class StreamTarget:
    connection_id: str
    dashboard_id: str
    pk: str
    sk: str


@dataclass(frozen=True)
class NotificationRule:
    user_pk: str
    rule_sk: str
    rule_id: str
    name: str
    dashboard_id: str
    symbol: str
    indicator_id: str
    condition: dict[str, Any]
    channels: dict[str, bool]
    cooldown_seconds: int
    enabled: bool
    last_triggered_at: int | None


def _compare_values(left: float, comparator: str, right: float) -> bool:
    if comparator == "GT":
        return left > right
    if comparator == "GTE":
        return left >= right
    if comparator == "LT":
        return left < right
    if comparator == "LTE":
        return left <= right
    if comparator == "EQ":
        return left == right
    if comparator == "NEQ":
        return left != right
    return False


def _evaluate_condition(condition: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    condition_type = str(condition.get("type", "")).lower()
    if condition_type == "signal":
        field = str(condition.get("field", "")).strip()
        expected_signal = str(condition.get("signal", "")).strip().upper()
        if not field or not expected_signal:
            return False
        return str(snapshot.get(field, "")).upper() == expected_signal

    if condition_type == "metric":
        field = str(condition.get("field", "")).strip()
        comparator = str(condition.get("comparator", "")).strip().upper()
        raw_threshold = condition.get("value")
        if not field or comparator == "":
            return False
        try:
            threshold = float(raw_threshold)
            metric_value = float(snapshot.get(field))
        except (TypeError, ValueError):
            return False
        return _compare_values(metric_value, comparator, threshold)

    if condition_type == "group":
        operator = str(condition.get("operator", "AND")).strip().upper()
        children = condition.get("conditions")
        if not isinstance(children, list) or not children:
            return False
        child_results = [
            _evaluate_condition(child, snapshot)
            for child in children
            if isinstance(child, dict)
        ]
        if not child_results:
            return False
        if operator == "OR":
            return any(child_results)
        return all(child_results)

    return False


def _cooldown_elapsed(last_triggered_at: int | None, cooldown_seconds: int, now_epoch: int) -> bool:
    if cooldown_seconds <= 0:
        return True
    if last_triggered_at is None:
        return True
    return (now_epoch - last_triggered_at) >= cooldown_seconds


def _normalize_symbol(value: Any) -> str:
    return str(value).strip().upper()


def _safe_series_payload(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _safe_notification_payload(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


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


def _get_apigw_client():
    global apigw_client
    if apigw_client is not None:
        return apigw_client
    if not WEBSOCKET_ENDPOINT:
        raise RuntimeError("WEBSOCKET_API_ENDPOINT is not configured")
    apigw_client = boto3.client("apigatewaymanagementapi", endpoint_url=WEBSOCKET_ENDPOINT)
    return apigw_client


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


def _scan_all_items(dynamo_table, *, filter_expression) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    last_evaluated_key = None

    while True:
        kwargs = {"FilterExpression": filter_expression}
        if last_evaluated_key:
            kwargs["ExclusiveStartKey"] = last_evaluated_key
        response = dynamo_table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    return items


def _dashboard_id_from_sk(sk_value: Any) -> str:
    sk = str(sk_value or "")
    return sk.split("#", 1)[1] if sk.startswith("DASHBOARD#") else ""


def _load_dashboard_symbols_and_owners(
    dynamo_table=table,
) -> tuple[dict[str, set[str]], dict[str, str]]:
    dashboard_symbols: dict[str, set[str]] = defaultdict(set)
    dashboard_owner_pk: dict[str, str] = {}

    # Current persistence model: PK=USER#..., SK=DASHBOARD#..., symbols stored on dashboard row.
    user_dashboard_items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("USER#") & Attr("SK").begins_with("DASHBOARD#"),
    )
    for item in user_dashboard_items:
        dashboard_id = str(item.get("dashboard_id") or _dashboard_id_from_sk(item.get("SK"))).strip()
        if not dashboard_id:
            continue
        owner_pk = str(item.get("PK", "")).strip()
        if owner_pk:
            dashboard_owner_pk[dashboard_id] = owner_pk
        for symbol in item.get("symbols", []) or []:
            normalized = _normalize_symbol(symbol)
            if normalized:
                dashboard_symbols[dashboard_id].add(normalized)

    # Backward compatibility with legacy dashboard-symbol mapping rows.
    legacy_dashboard_items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("DASH#") & Attr("SK").begins_with("SYMBOL#"),
    )
    for item in legacy_dashboard_items:
        dashboard_pk = str(item.get("PK", ""))
        if "#" not in dashboard_pk:
            continue
        dashboard_id = dashboard_pk.split("#", 1)[1]
        ticker_code = item.get("ticker_code")
        if not ticker_code:
            symbol_sk = str(item.get("SK", ""))
            if symbol_sk.startswith("SYMBOL#"):
                ticker_code = symbol_sk.split("#", 1)[1]
        normalized = _normalize_symbol(ticker_code)
        if normalized:
            dashboard_symbols[dashboard_id].add(normalized)

    return dashboard_symbols, dashboard_owner_pk


def _load_notification_rules_by_dashboard(
    dynamo_table=table,
) -> dict[str, list[NotificationRule]]:
    items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("USER#") & Attr("SK").begins_with("NOTIFICATION_RULE#"),
    )

    rules_by_dashboard: dict[str, list[NotificationRule]] = defaultdict(list)
    for item in items:
        dashboard_id = str(item.get("dashboard_id", "")).strip()
        rule_id = str(item.get("notification_rule_id", "")).strip()
        if not dashboard_id or not rule_id:
            continue
        condition = item.get("condition")
        channels = item.get("channels") or {}
        if not isinstance(condition, dict) or not isinstance(channels, dict):
            continue

        rule = NotificationRule(
            user_pk=str(item.get("PK", "")).strip(),
            rule_sk=str(item.get("SK", "")).strip(),
            rule_id=rule_id,
            name=str(item.get("rule_name", rule_id)),
            dashboard_id=dashboard_id,
            symbol=_normalize_symbol(item.get("symbol", "")),
            indicator_id=str(item.get("indicator_id", "")).strip(),
            condition=condition,
            channels={
                "inApp": bool(channels.get("inApp", True)),
                "push": bool(channels.get("push", False)),
            },
            cooldown_seconds=max(int(item.get("cooldown_seconds", 0) or 0), 0),
            enabled=bool(item.get("enabled", False)),
            last_triggered_at=int(item.get("last_triggered_at")) if item.get("last_triggered_at") is not None else None,
        )
        rules_by_dashboard[dashboard_id].append(rule)

    return rules_by_dashboard


def _persist_notification_event_and_cooldown(
    dynamo_table,
    *,
    rule: NotificationRule,
    snapshot: dict[str, Any],
    now_epoch: int,
) -> dict[str, Any] | None:
    if not rule.user_pk or not rule.rule_sk:
        return None

    event_id = f"evt_{uuid.uuid4().hex[:12]}"
    symbol = _normalize_symbol(snapshot.get("symbol", rule.symbol))
    message = (
        f"{rule.name} triggered for {symbol}: "
        f"price={snapshot.get('price')} mtf={snapshot.get('mtf_signal')} trend={snapshot.get('trend_signal')}"
    )

    dynamo_table.put_item(
        Item={
            "PK": rule.user_pk,
            "SK": f"NOTIFICATION_EVENT#{event_id}",
            "entity_type": "NOTIFICATION_EVENT",
            "notification_event_id": event_id,
            "notification_rule_id": rule.rule_id,
            "dashboard_id": rule.dashboard_id,
            "symbol": symbol,
            "message": message,
            "triggered_at": now_epoch,
            "channels": rule.channels,
            "created_at": now_epoch,
        }
    )

    dynamo_table.update_item(
        Key={"PK": rule.user_pk, "SK": rule.rule_sk},
        UpdateExpression="SET #last_triggered_at = :last_triggered_at, #updated_at = :updated_at",
        ExpressionAttributeNames={
            "#last_triggered_at": "last_triggered_at",
            "#updated_at": "updated_at",
        },
        ExpressionAttributeValues={
            ":last_triggered_at": now_epoch,
            ":updated_at": now_epoch,
        },
    )

    return {
        "id": event_id,
        "rule_id": rule.rule_id,
        "ruleId": rule.rule_id,
        "dashboard_id": rule.dashboard_id,
        "dashboardId": rule.dashboard_id,
        "symbol": symbol,
        "message": message,
        "triggered_at_epoch": now_epoch,
        "triggeredAtEpoch": now_epoch,
        "channels": rule.channels,
    }


def _evaluate_dashboard_notifications(
    *,
    dashboard_id: str,
    live_data: dict[str, dict[str, Any]],
    rules: list[NotificationRule],
    now_epoch: int,
    dynamo_table=table,
) -> list[dict[str, Any]]:
    if not rules:
        return []

    matched_events: list[dict[str, Any]] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.dashboard_id != dashboard_id:
            continue
        if not _cooldown_elapsed(rule.last_triggered_at, rule.cooldown_seconds, now_epoch):
            continue

        snapshot = live_data.get(rule.symbol)
        if not snapshot:
            continue
        if not _evaluate_condition(rule.condition, snapshot):
            continue

        try:
            event = _persist_notification_event_and_cooldown(
                dynamo_table,
                rule=rule,
                snapshot=snapshot,
                now_epoch=now_epoch,
            )
            if event:
                matched_events.append(event)
        except Exception as exc:  # noqa: BLE001 - do not fail main stream loop
            LOGGER.warning("Failed to persist notification event for rule %s: %s", rule.rule_id, exc)

    return matched_events


def _load_push_subscriptions_by_user(dynamo_table=table) -> dict[str, list[dict[str, Any]]]:
    items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("USER#") & Attr("SK").begins_with("PUSH_SUBSCRIPTION#"),
    )
    by_user: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        user_pk = str(item.get("PK", "")).strip()
        endpoint = str(item.get("endpoint", "")).strip()
        keys = item.get("keys")
        if not user_pk or not endpoint or not isinstance(keys, dict):
            continue
        by_user[user_pk].append({"endpoint": endpoint, "keys": keys})
    return by_user


def _push_subscription_sk(endpoint: str) -> str:
    digest = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
    return f"PUSH_SUBSCRIPTION#{digest}"


def _remove_push_subscription(user_pk: str, endpoint: str, dynamo_table=table) -> None:
    try:
        dynamo_table.delete_item(
            Key={
                "PK": user_pk,
                "SK": _push_subscription_sk(endpoint),
            }
        )
    except Exception as exc:  # noqa: BLE001 - best-effort cleanup only
        LOGGER.warning("Failed to delete stale push subscription for %s: %s", endpoint, exc)


def _web_push_enabled() -> bool:
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_SUBJECT and webpush is not None)


def _build_push_notification_payload(event: dict[str, Any], rule: NotificationRule) -> dict[str, Any]:
    message = str(event.get("message", "")).strip()
    title = str(getattr(rule, "name", "") or getattr(rule, "rule_id", "") or message or "Notification")
    return {
        "title": title,
        "body": message,
        "dashboardId": str(event.get("dashboardId") or event.get("dashboard_id") or rule.dashboard_id),
        "ruleId": str(event.get("ruleId") or event.get("rule_id") or rule.rule_id),
        "symbol": str(event.get("symbol") or rule.symbol),
        "triggeredAtEpoch": int(event.get("triggeredAtEpoch") or event.get("triggered_at_epoch") or time.time()),
        "message": message,
    }


def _send_web_push(subscription: dict[str, Any], payload: dict[str, Any]) -> None:
    if not _web_push_enabled():
        LOGGER.warning("Web push is disabled because VAPID configuration is incomplete")
        return

    webpush(
        subscription_info=subscription,
        data=_safe_notification_payload(payload),
        vapid_private_key=VAPID_PRIVATE_KEY,
        vapid_claims={"sub": VAPID_SUBJECT},
    )


def _is_stale_push_subscription_error(exc: Exception) -> bool:
    if WebPushException is not None and isinstance(exc, WebPushException):
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
        if status_code in {404, 410}:
            return True

    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return status_code in {404, 410}


def _dispatch_push_notifications(
    *,
    events: list[dict[str, Any]],
    subscriptions_by_user: dict[str, list[dict[str, Any]]],
    rules_by_dashboard: dict[str, list[NotificationRule]],
) -> None:
    if not events:
        return

    rule_lookup: dict[str, NotificationRule] = {}
    for dashboard_rules in rules_by_dashboard.values():
        for rule in dashboard_rules:
            rule_lookup[rule.rule_id] = rule

    for event in events:
        if not bool(event.get("channels", {}).get("push", False)):
            continue
        rule_id = str(event.get("rule_id") or event.get("ruleId") or "")
        rule = rule_lookup.get(rule_id)
        if not rule:
            continue
        user_subscriptions = subscriptions_by_user.get(rule.user_pk, [])
        if not user_subscriptions:
            continue
        for subscription in user_subscriptions:
            endpoint = str(subscription.get("endpoint", "")).strip()
            if not endpoint:
                continue
            try:
                _send_web_push(subscription, _build_push_notification_payload(event, rule))
                LOGGER.info(
                    "Push notification delivered rule=%s user=%s endpoint=%s event=%s",
                    rule.rule_id,
                    rule.user_pk,
                    endpoint,
                    event.get("id", ""),
                )
            except Exception as exc:  # noqa: BLE001 - push delivery must not fail the poll loop
                if _is_stale_push_subscription_error(exc):
                    LOGGER.info("Removing stale push subscription endpoint=%s: %s", endpoint, exc)
                    _remove_push_subscription(rule.user_pk, endpoint)
                else:
                    LOGGER.warning(
                        "Push notification failed rule=%s user=%s endpoint=%s: %s",
                        rule.rule_id,
                        rule.user_pk,
                        endpoint,
                        exc,
                    )


def get_active_targets(
    dynamo_table=table,
) -> tuple[dict[str, set[str]], list[StreamTarget]]:
    dashboard_symbols, _ = _load_dashboard_symbols_and_owners(dynamo_table)

    connection_items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("WS_CONNECTION#"),
    )
    stream_targets: list[StreamTarget] = []
    for item in connection_items:
        pk = item.get("PK", "")
        sk = item.get("SK", "")
        if not pk.startswith("WS_CONNECTION#"):
            continue
        connection_id = pk.split("#", 1)[1]
        dashboard_id = sk.split("#", 1)[1] if sk.startswith("DASHBOARD#") else "default"
        stream_targets.append(
            StreamTarget(
                connection_id=connection_id,
                dashboard_id=dashboard_id,
                pk=pk,
                sk=sk,
            )
        )

    return dashboard_symbols, stream_targets


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


def _fetch_live_data(tickers: Iterable[str], stock_engine: Any) -> dict[str, dict[str, Any]]:
    live_data, _ = _fetch_live_data_with_history(tickers, stock_engine)
    return live_data


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


def _broadcast_payload(connection_id: str, payload: dict[str, Any]) -> None:
    client = _get_apigw_client()
    client.post_to_connection(ConnectionId=connection_id, Data=_safe_series_payload(payload))


def _is_stale_connection_error(exc: Exception) -> bool:
    if not isinstance(exc, ClientError):
        return False
    metadata = exc.response.get("ResponseMetadata", {})
    status_code = metadata.get("HTTPStatusCode")
    error_code = exc.response.get("Error", {}).get("Code")
    return status_code == 410 or error_code in {"GoneException", "ForbiddenException"}


async def poll_and_broadcast(runtime_budget_seconds: int | None = None) -> None:
    start_time = time.monotonic()
    runtime_limit = MAX_RUNTIME_SECONDS if runtime_budget_seconds is None else min(
        MAX_RUNTIME_SECONDS, max(runtime_budget_seconds, 1)
    )
    stock_engine = _create_stock_engine()
    history_delivered_connections: set[str] = set()

    while time.monotonic() - start_time < runtime_limit:
        loop_start = time.monotonic()
        dashboard_symbols, stream_targets = get_active_targets()
        notification_rules_by_dashboard = _load_notification_rules_by_dashboard()

        if not stream_targets:
            await asyncio.sleep(min(NO_TARGET_RETRY_SECONDS, POLL_INTERVAL_SECONDS))
            continue

        tickers = sorted({ticker for symbols in dashboard_symbols.values() for ticker in symbols})
        if not tickers:
            await asyncio.sleep(min(NO_TARGET_RETRY_SECONDS, POLL_INTERVAL_SECONDS))
            continue

        try:
            live_data, history_by_symbol = _fetch_live_data_with_history(tickers, stock_engine)
        except (BotoCoreError, ClientError, RuntimeError, ValueError) as exc:
            LOGGER.warning("Data ingestion anomaly: %s", exc)
            await asyncio.sleep(min(5, POLL_INTERVAL_SECONDS))
            continue

        if not live_data:
            await asyncio.sleep(min(3, POLL_INTERVAL_SECONDS))
            continue

        now_epoch = int(time.time())
        in_app_notifications_by_dashboard: dict[str, list[dict[str, Any]]] = {}
        all_matched_events: list[dict[str, Any]] = []
        for dashboard_id, rules in notification_rules_by_dashboard.items():
            events = _evaluate_dashboard_notifications(
                dashboard_id=dashboard_id,
                live_data=live_data,
                rules=rules,
                now_epoch=now_epoch,
                dynamo_table=table,
            )
            if events:
                all_matched_events.extend(events)
                in_app_notifications_by_dashboard[dashboard_id] = [
                    event for event in events if bool(event.get("channels", {}).get("inApp", False))
                ]

        subscriptions_by_user = _load_push_subscriptions_by_user()
        _dispatch_push_notifications(
            events=all_matched_events,
            subscriptions_by_user=subscriptions_by_user,
            rules_by_dashboard=notification_rules_by_dashboard,
        )

        for target in stream_targets:
            if not target.connection_id:
                continue

            target_symbols = dashboard_symbols.get(target.dashboard_id, set())
            scoped_data = {symbol: live_data[symbol] for symbol in target_symbols if symbol in live_data}

            # Backward compatibility: if no dashboard-symbol mapping exists, stream full universe.
            if not scoped_data and not target_symbols:
                scoped_data = live_data

            if not scoped_data:
                continue

            include_history = target.connection_id not in history_delivered_connections
            scoped_history: dict[str, list[dict[str, Any]]] = {}
            if include_history:
                scoped_history = {
                    symbol: history_by_symbol.get(symbol, [])
                    for symbol in scoped_data
                    if history_by_symbol.get(symbol)
                }

            packet = {
                "dashboard_id": target.dashboard_id,
                "connection_id": target.connection_id,
                "as_of_epoch": now_epoch,
                "data": scoped_data,
            }
            if scoped_history:
                packet["history"] = scoped_history
            notifications = in_app_notifications_by_dashboard.get(target.dashboard_id, [])
            if notifications:
                packet["notifications"] = notifications

            try:
                _broadcast_payload(target.connection_id, packet)
                history_delivered_connections.add(target.connection_id)
            except Exception as exc:  # noqa: BLE001 - prune dead connections only
                if _is_stale_connection_error(exc):
                    LOGGER.info("Dropping stale connection %s: %s", target.connection_id, exc)
                    table.delete_item(Key={"PK": target.pk, "SK": target.sk})
                    history_delivered_connections.discard(target.connection_id)
                else:
                    LOGGER.warning("Failed to broadcast to %s: %s", target.connection_id, exc)

        elapsed = time.monotonic() - loop_start
        remaining = runtime_limit - (time.monotonic() - start_time)
        if remaining <= 1:
            break
        await asyncio.sleep(min(max(POLL_INTERVAL_SECONDS - elapsed, 1), remaining))


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    runtime_budget_seconds = None
    if context is not None and hasattr(context, "get_remaining_time_in_millis"):
        remaining_ms = int(context.get_remaining_time_in_millis())
        runtime_budget_seconds = max((remaining_ms - 1500) // 1000, 1)

    asyncio.run(poll_and_broadcast(runtime_budget_seconds=runtime_budget_seconds))
    return {"statusCode": 200, "body": "Cycle complete"}
