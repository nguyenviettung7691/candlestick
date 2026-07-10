from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import _cooldown_elapsed, _dispatch_push_notifications, _evaluate_condition  # noqa: E402


def test_evaluate_signal_condition_matches_case_insensitive() -> None:
    snapshot = {"trend_signal": "BULLISH_TREND"}
    condition = {
        "type": "signal",
        "field": "trend_signal",
        "signal": "bullish_trend",
    }

    assert _evaluate_condition(condition, snapshot) is True


def test_evaluate_metric_condition_with_comparator() -> None:
    snapshot = {"price": 99.5}
    condition = {
        "type": "metric",
        "field": "price",
        "comparator": "LTE",
        "value": 100,
    }

    assert _evaluate_condition(condition, snapshot) is True


def test_evaluate_group_condition_and_or() -> None:
    snapshot = {
        "price": 120,
        "mtf_score": 82,
        "mtf_signal": "BUY",
    }
    condition = {
        "type": "group",
        "operator": "AND",
        "conditions": [
            {
                "type": "metric",
                "field": "price",
                "comparator": "GTE",
                "value": 100,
            },
            {
                "type": "group",
                "operator": "OR",
                "conditions": [
                    {
                        "type": "signal",
                        "field": "mtf_signal",
                        "signal": "SELL",
                    },
                    {
                        "type": "metric",
                        "field": "mtf_score",
                        "comparator": "GTE",
                        "value": 80,
                    },
                ],
            },
        ],
    }

    assert _evaluate_condition(condition, snapshot) is True


def test_cooldown_elapsed_with_and_without_last_trigger() -> None:
    assert _cooldown_elapsed(last_triggered_at=None, cooldown_seconds=300, now_epoch=1_000) is True
    assert _cooldown_elapsed(last_triggered_at=900, cooldown_seconds=200, now_epoch=1_000) is False
    assert _cooldown_elapsed(last_triggered_at=700, cooldown_seconds=200, now_epoch=1_000) is True


def test_dispatch_push_notifications_sends_payload_for_enabled_rule(monkeypatch) -> None:
    deliveries: list[tuple[dict[str, object], dict[str, object]]] = []

    monkeypatch.setattr("app.VAPID_PUBLIC_KEY", "public")
    monkeypatch.setattr("app.VAPID_PRIVATE_KEY", "private")
    monkeypatch.setattr("app.VAPID_SUBJECT", "mailto:test@example.com")
    monkeypatch.setattr("app.webpush", lambda **kwargs: deliveries.append((kwargs["subscription_info"], json.loads(kwargs["data"].decode("utf-8")))))

    event = {
        "id": "evt_1",
        "rule_id": "rule_1",
        "ruleId": "rule_1",
        "dashboard_id": "dash_1",
        "dashboardId": "dash_1",
        "symbol": "FPT",
        "message": "Rule triggered",
        "triggered_at_epoch": 1_234,
        "triggeredAtEpoch": 1_234,
        "channels": {"inApp": True, "push": True},
    }
    rule = SimpleNamespace(rule_id="rule_1", user_pk="USER#abc", dashboard_id="dash_1", symbol="FPT")

    _dispatch_push_notifications(
        events=[event],
        subscriptions_by_user={"USER#abc": [{"endpoint": "https://push.example.test", "keys": {"p256dh": "key", "auth": "auth"}}]},
        rules_by_dashboard={"dash_1": [rule]},
    )

    assert len(deliveries) == 1
    subscription, payload = deliveries[0]
    assert subscription["endpoint"] == "https://push.example.test"
    assert payload["title"] == "rule_1"
    assert payload["symbol"] == "FPT"
    assert payload["triggeredAtEpoch"] == 1_234


def test_dispatch_push_notifications_cleans_up_stale_subscription(monkeypatch) -> None:
    removals: list[tuple[str, str]] = []

    class StalePushError(Exception):
        def __init__(self) -> None:
            super().__init__("gone")
            self.response = SimpleNamespace(status_code=410)

    monkeypatch.setattr("app.VAPID_PUBLIC_KEY", "public")
    monkeypatch.setattr("app.VAPID_PRIVATE_KEY", "private")
    monkeypatch.setattr("app.VAPID_SUBJECT", "mailto:test@example.com")
    monkeypatch.setattr("app.webpush", lambda **kwargs: (_ for _ in ()).throw(StalePushError()))
    monkeypatch.setattr("app._remove_push_subscription", lambda user_pk, endpoint, dynamo_table=None: removals.append((user_pk, endpoint)))

    event = {
        "id": "evt_2",
        "rule_id": "rule_2",
        "ruleId": "rule_2",
        "dashboard_id": "dash_2",
        "dashboardId": "dash_2",
        "symbol": "HPG",
        "message": "Rule triggered",
        "triggered_at_epoch": 2_345,
        "triggeredAtEpoch": 2_345,
        "channels": {"inApp": True, "push": True},
    }
    rule = SimpleNamespace(rule_id="rule_2", user_pk="USER#def", dashboard_id="dash_2", symbol="HPG")

    _dispatch_push_notifications(
        events=[event],
        subscriptions_by_user={"USER#def": [{"endpoint": "https://push.example.test/stale", "keys": {"p256dh": "key", "auth": "auth"}}]},
        rules_by_dashboard={"dash_2": [rule]},
    )

    assert removals == [("USER#def", "https://push.example.test/stale")]
