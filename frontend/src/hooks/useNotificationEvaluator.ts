"use client";

import { useEffect, useRef } from 'react';

import { buildNotificationMessage, findFiredRules } from '@/lib/client/notifications';
import { createNotificationEvent, updateNotificationRule } from '@/lib/client/persistence';
import type { NotificationEvent, NotificationRule, StreamPacket } from '@/lib/types';

interface UseNotificationEvaluatorOptions {
  rules: NotificationRule[];
  packet: StreamPacket | null;
  dashboardId: string;
  onEvents: (events: NotificationEvent[]) => void;
  onRuleTriggered?: (ruleId: string, triggeredAtEpoch: number) => void;
}

/**
 * Evaluates the user's notification rules against each incoming WebSocket
 * packet entirely in the browser. Matching rules produce {@link NotificationEvent}
 * records that are persisted to IndexedDB (via {@link createNotificationEvent})
 * and pushed to the in-app feed through `onEvents`. The rule's cooldown is
 * honored both across reloads (persisted `lastTriggeredAtEpoch`) and within a
 * session (in-memory ref).
 */
export function useNotificationEvaluator({
  rules,
  packet,
  dashboardId,
  onEvents,
  onRuleTriggered,
}: UseNotificationEvaluatorOptions): void {
  const firedRef = useRef<Record<string, number>>({});
  const onEventsRef = useRef(onEvents);
  const onRuleTriggeredRef = useRef(onRuleTriggered);
  onEventsRef.current = onEvents;
  onRuleTriggeredRef.current = onRuleTriggered;

  useEffect(() => {
    if (!packet || packet.dashboard_id !== dashboardId) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const fired = findFiredRules(rules, packet, now);
    if (fired.length === 0) {
      return;
    }

    let cancelled = false;

    (async () => {
      const created: NotificationEvent[] = [];

      for (const { rule, snapshot } of fired) {
        // Re-check cooldown against the in-session timestamp to avoid duplicate
        // fires while the persisted rule update is still in flight.
        const last = rule.lastTriggeredAtEpoch ?? firedRef.current[rule.id] ?? 0;
        if (last > 0 && now - last < rule.cooldownSeconds) {
          continue;
        }

        const event = await createNotificationEvent({
          ruleId: rule.id,
          dashboardId: rule.dashboardId,
          symbol: rule.symbol,
          message: buildNotificationMessage(rule, snapshot),
          channels: rule.channels,
        });

        created.push(event);
        firedRef.current[rule.id] = event.triggeredAtEpoch;
        onRuleTriggeredRef.current?.(rule.id, event.triggeredAtEpoch);
      }

      if (!cancelled && created.length > 0) {
        onEventsRef.current(created);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [packet, dashboardId, rules]);
}
