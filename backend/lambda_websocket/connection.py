from __future__ import annotations

import json
import os
import time
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key


DYNAMO_TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME", "CandlestickDashboardTable")
WS_CONNECTION_TTL_SECONDS = int(os.environ.get("WS_CONNECTION_TTL_SECONDS", "3600"))
WS_CONNECTION_PREFIX = "WS_CONNECTION#"
DASHBOARD_PREFIX = "DASHBOARD#"

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(DYNAMO_TABLE_NAME)


def _connection_id(event: dict[str, Any]) -> str:
    connection_id = event.get("requestContext", {}).get("connectionId", "")
    return str(connection_id).strip()


def _dashboard_id(event: dict[str, Any]) -> str:
    params = event.get("queryStringParameters") or {}
    dashboard_id = params.get("dashboardId") or params.get("dashboard_id") or "default"
    return str(dashboard_id).strip() or "default"


def _connection_pk(connection_id: str) -> str:
    return f"{WS_CONNECTION_PREFIX}{connection_id}"


def _dashboard_sk(dashboard_id: str) -> str:
    return f"{DASHBOARD_PREFIX}{dashboard_id}"


def _delete_connection_rows(connection_id: str) -> None:
    last_evaluated_key: dict[str, Any] | None = None
    while True:
        query_kwargs: dict[str, Any] = {"KeyConditionExpression": Key("PK").eq(_connection_pk(connection_id))}
        if last_evaluated_key:
            query_kwargs["ExclusiveStartKey"] = last_evaluated_key

        response = table.query(**query_kwargs)
        for item in response.get("Items", []):
            pk = item.get("PK")
            sk = item.get("SK")
            if pk and sk:
                table.delete_item(Key={"PK": pk, "SK": sk})

        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break


def handle_connect(event: dict[str, Any], context: Any) -> dict[str, Any]:
    connection_id = _connection_id(event)
    if not connection_id:
        return {"statusCode": 400, "body": json.dumps({"message": "missing connection id"})}

    dashboard_id = _dashboard_id(event)
    now_epoch = int(time.time())
    table.put_item(
        Item={
            "PK": _connection_pk(connection_id),
            "SK": _dashboard_sk(dashboard_id),
            "connected_at": now_epoch,
            "ttl": now_epoch + WS_CONNECTION_TTL_SECONDS,
        }
    )
    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "connected",
                "connection_id": connection_id,
                "dashboard_id": dashboard_id,
                "connected_at": now_epoch,
                "ttl": now_epoch + WS_CONNECTION_TTL_SECONDS,
            }
        ),
    }


def handle_disconnect(event: dict[str, Any], context: Any) -> dict[str, Any]:
    connection_id = _connection_id(event)
    if connection_id:
        _delete_connection_rows(connection_id)
    return {"statusCode": 200, "body": json.dumps({"message": "disconnected"})}


def handle_default(event: dict[str, Any], context: Any) -> dict[str, Any]:
    body = event.get("body") or "{}"
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        payload = {"message": body}
    return {"statusCode": 200, "body": json.dumps({"received": payload})}


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    route_key = event.get("requestContext", {}).get("routeKey", "$default")
    if route_key == "$connect":
        return handle_connect(event, context)
    if route_key == "$disconnect":
        return handle_disconnect(event, context)
    return handle_default(event, context)
