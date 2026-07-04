from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

import boto3
import pandas as pd
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import BotoCoreError, ClientError
from vnstock3 import Vnstock

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
STOCK_DATA_SOURCE = os.environ.get("STOCK_DATA_SOURCE", "VCI")


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(DYNAMO_TABLE_NAME)
apigw_client = None


@dataclass(frozen=True)
class StreamTarget:
    connection_id: str
    dashboard_id: str
    pk: str
    sk: str


def _normalize_symbol(value: Any) -> str:
    return str(value).strip().upper()


def _safe_series_payload(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _get_apigw_client():
    global apigw_client
    if apigw_client is not None:
        return apigw_client
    if not WEBSOCKET_ENDPOINT:
        raise RuntimeError("WEBSOCKET_API_ENDPOINT is not configured")
    apigw_client = boto3.client("apigatewaymanagementapi", endpoint_url=WEBSOCKET_ENDPOINT)
    return apigw_client


def _resample_frame(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    if "time" not in df.columns:
        return df.copy()

    indexed = df.copy()
    indexed["time"] = pd.to_datetime(indexed["time"], errors="coerce")
    indexed = indexed.dropna(subset=["time"]).set_index("time")
    if indexed.empty:
        return df.copy()
    aggregated = indexed.resample(rule).last().dropna(how="all")
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


def get_active_targets(
    dynamo_table=table,
) -> tuple[dict[str, set[str]], list[StreamTarget]]:
    dashboard_items = _scan_all_items(
        dynamo_table,
        filter_expression=Attr("PK").begins_with("DASH#") & Attr("SK").begins_with("SYMBOL#"),
    )
    dashboard_symbols: dict[str, set[str]] = defaultdict(set)
    for item in dashboard_items:
        dashboard_pk = item.get("PK", "")
        symbol_sk = item.get("SK", "")
        if "#" not in dashboard_pk:
            continue
        dashboard_id = dashboard_pk.split("#", 1)[1]
        ticker_code = item.get("ticker_code")
        if not ticker_code and symbol_sk.startswith("SYMBOL#"):
            ticker_code = symbol_sk.split("#", 1)[1]
        if ticker_code:
            normalized_ticker = _normalize_symbol(ticker_code)
            if normalized_ticker:
                dashboard_symbols[dashboard_id].add(normalized_ticker)

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
    df_1w = _resample_frame(df_1d, "W")
    df_1m = _resample_frame(df_1d, "M")
    latest_price = float(df_1d["close"].iloc[-1])

    mtf = calculate_mtf_scoring(df_1d, df_1w, df_1m, {})
    ls_dvp = calculate_ls_dvp(df_1d, {})
    zsb = calculate_mr_zsb(df_1d, {})
    atrm = calculate_atrm(df_1d, {})

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


def _fetch_live_data(tickers: Iterable[str], stock_engine: Vnstock) -> dict[str, dict[str, Any]]:
    live_data: dict[str, dict[str, Any]] = {}
    for ticker in tickers:
        try:
            market = stock_engine.stock(symbol=ticker, source=STOCK_DATA_SOURCE)
            df_1d = market.trading.history(period="1D", size=PRICE_HISTORY_SIZE)
            if df_1d is None or getattr(df_1d, "empty", True):
                continue
            live_data[ticker] = _build_live_packet(ticker, df_1d)
        except Exception as exc:  # noqa: BLE001 - continue processing other symbols
            LOGGER.warning("Failed to fetch/build packet for %s: %s", ticker, exc)
    return live_data


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
    stock_engine = Vnstock()

    while time.monotonic() - start_time < runtime_limit:
        loop_start = time.monotonic()
        dashboard_symbols, stream_targets = get_active_targets()

        if not stream_targets:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            continue

        tickers = sorted({ticker for symbols in dashboard_symbols.values() for ticker in symbols})
        if not tickers:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            continue

        try:
            live_data = _fetch_live_data(tickers, stock_engine)
        except (BotoCoreError, ClientError, RuntimeError, ValueError) as exc:
            LOGGER.warning("Data ingestion anomaly: %s", exc)
            await asyncio.sleep(min(5, POLL_INTERVAL_SECONDS))
            continue

        if not live_data:
            await asyncio.sleep(min(3, POLL_INTERVAL_SECONDS))
            continue

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

            packet = {
                "dashboard_id": target.dashboard_id,
                "connection_id": target.connection_id,
                "as_of_epoch": int(time.time()),
                "data": scoped_data,
            }

            try:
                _broadcast_payload(target.connection_id, packet)
            except Exception as exc:  # noqa: BLE001 - prune dead connections only
                if _is_stale_connection_error(exc):
                    LOGGER.info("Dropping stale connection %s: %s", target.connection_id, exc)
                    table.delete_item(Key={"PK": target.pk, "SK": target.sk})
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
