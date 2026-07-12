"use client";

import { useEffect, useRef, useState } from 'react';

import type { DashboardTickerSnapshot, NotificationEvent, StreamHistoryBar, StreamPacket } from '@/lib/types';

interface UseWebSocketOptions {
  url: string;
  dashboardId: string;
  symbols?: string[];
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

function normalizeWebSocketUrl(rawUrl: string): URL {
  const socketUrl = new URL(rawUrl);
  if (socketUrl.protocol === 'http:') {
    socketUrl.protocol = 'ws:';
  } else if (socketUrl.protocol === 'https:') {
    socketUrl.protocol = 'wss:';
  }
  return socketUrl;
}

function isDashboardTickerSnapshot(value: unknown): value is DashboardTickerSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.symbol === 'string' &&
    (row.company_name === undefined || typeof row.company_name === 'string') &&
    typeof row.price === 'number' &&
    typeof row.mtf_score === 'number' &&
    typeof row.mtf_signal === 'string' &&
    typeof row.ls_ratio === 'number' &&
    typeof row.ls_signal === 'string' &&
    typeof row.z_score === 'number' &&
    typeof row.z_signal === 'string' &&
    typeof row.trend_delta === 'number' &&
    typeof row.trend_signal === 'string'
  );
}

function isNotificationEvent(value: unknown): value is NotificationEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.ruleId === 'string' &&
    typeof event.dashboardId === 'string' &&
    typeof event.symbol === 'string' &&
    typeof event.message === 'string' &&
    typeof event.triggeredAtEpoch === 'number' &&
    event.channels !== null &&
    typeof event.channels === 'object' &&
    typeof (event.channels as Record<string, unknown>).inApp === 'boolean' &&
    typeof (event.channels as Record<string, unknown>).push === 'boolean'
  );
}

function isStreamHistoryBar(value: unknown): value is StreamHistoryBar {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const bar = value as Record<string, unknown>;
  return (
    typeof bar.time === 'number' &&
    typeof bar.open === 'number' &&
    typeof bar.high === 'number' &&
    typeof bar.low === 'number' &&
    typeof bar.close === 'number'
  );
}

function isStreamPacket(value: unknown): value is StreamPacket {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const packet = value as Record<string, unknown>;
  if (typeof packet.dashboard_id !== 'string' || typeof packet.connection_id !== 'string') {
    return false;
  }
  if (!packet.data || typeof packet.data !== 'object') {
    return false;
  }

  const rows = packet.data as Record<string, unknown>;
  if (!Object.values(rows).every(isDashboardTickerSnapshot)) {
    return false;
  }

  if (packet.history !== undefined) {
    if (!packet.history || typeof packet.history !== 'object') {
      return false;
    }

    const historyBySymbol = packet.history as Record<string, unknown>;
    if (
      !Object.values(historyBySymbol).every(
        (series) => Array.isArray(series) && series.every(isStreamHistoryBar),
      )
    ) {
      return false;
    }
  }

  if (packet.notifications === undefined) {
    return true;
  }

  if (!Array.isArray(packet.notifications)) {
    return false;
  }

  return packet.notifications.every(isNotificationEvent);
}

export function useWebSocket({ url, dashboardId, symbols = [] }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [lastPacket, setLastPacket] = useState<StreamPacket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  // Interval reference for keep‑alive pings
  const pingIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let shouldReconnect = true;

    if (!dashboardId) {
      setConnected(false);
      return;
    }

    const clearRetry = () => {
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };

    const clearConnectTimer = () => {
      if (connectTimerRef.current !== null) {
        window.clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
    };
    // Clear keep‑alive ping interval
    const clearPingInterval = () => {
      if (pingIntervalRef.current !== null) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!mounted || !shouldReconnect) {
        return;
      }

      setConnected(false);
      setConnectionState('reconnecting');
      const nextDelay = Math.min(1000 * 2 ** attemptRef.current, 15000);
      attemptRef.current += 1;
      retryRef.current = window.setTimeout(connect, nextDelay);
    };

    const connect = () => {
      if (!mounted) {
        return;
      }

      clearRetry();
      clearPingInterval();
      console.debug('[useWebSocket] initiating connection attempt', { attempt: attemptRef.current });
      setConnectionState(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

      let socketUrl: URL;
      try {
        socketUrl = normalizeWebSocketUrl(url);
      } catch {
        setError('Invalid WebSocket endpoint URL configuration.');
        scheduleReconnect();
        return;
      }

      socketUrl.searchParams.set('dashboardId', dashboardId);

      const socket = new WebSocket(socketUrl.toString());
      socketRef.current = socket;
      // Start keep‑alive ping interval (30 s) to prevent idle timeout
      pingIntervalRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
+            console.debug('[useWebSocket] sending keep‑alive ping');
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            // ignore errors; reconnection logic will handle
          }
        }
      }, 30000);
    
      socket.onopen = () => {
        if (!mounted) {
          return;
        }
        attemptRef.current = 0;
        setConnected(true);
        setConnectionState('connected');
        setError(null);
        // When socket (re)connects, send the current dashboard symbols once.
        if (symbols && symbols.length) {
          socket.send(JSON.stringify({ type: 'subscribe', symbols }));
        }
      };

            socket.onmessage = (event) => {
              if (!mounted) {
                return;
              }
              try {
                const parsed = JSON.parse(event.data) as unknown;
                if (!isStreamPacket(parsed)) {
                  setError('Received an invalid stream payload.');
                  return;
                }
                if (parsed.dashboard_id !== dashboardId) {
                  return;
                }
                setLastPacket(parsed);
                setError(null);
              } catch {
                setError('Received an invalid stream payload.');
              }
            };

            socket.onerror = () => {
              if (mounted) {
                setError('WebSocket error while streaming dashboard data.');
              }
            };

            socket.onclose = (event: CloseEvent) => {
              if (!mounted || socket !== socketRef.current) {
                return;
              }
              // Only reconnect on abnormal closures. A normal closure (code 1000)
              // means the server intentionally ended the connection; treat it as
              // final so we don't spin up a brand‑new socket when nothing changed.
              if (event.code === 1000) {
                console.info('[useWebSocket] normal closure (1000); not reconnecting');
                setConnected(false);
                setConnectionState('connecting');
                return;
              }
              console.warn('[useWebSocket] abnormal socket close; clearing ping and scheduling reconnect', event.code, event.reason);
              clearPingInterval();
              scheduleReconnect();
            };
          };

    // Defer the initial connect to avoid creating a transient socket during
    // React Strict Mode's dev-only mount/unmount cycle.
    connectTimerRef.current = window.setTimeout(() => {
      connectTimerRef.current = null;
      connect();
    }, 0);

    return () => {
      mounted = false;
      shouldReconnect = false;
      clearRetry();
      clearConnectTimer();
      clearPingInterval();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [dashboardId, url]);

  // Re-subscribe whenever the dashboard's symbol list changes (or the
  // connection (re)opens). The main connection effect only runs on
  // dashboardId/url changes, so without this the server would keep streaming
  // the stale symbol set after an edit.
  useEffect(() => {
    const socket = socketRef.current;
    const isOpen = !!socket && socket.readyState === WebSocket.OPEN;
    if (isOpen && symbols && symbols.length) {
      try {
        socket.send(JSON.stringify({ type: 'subscribe', symbols }));
      } catch (err) {
        console.error('Failed to send subscribe on symbols change', err);
        setError('WebSocket send error while updating symbols subscription.');
      }
    }
  }, [symbols, connected]);

  return { connected, connectionState, lastPacket, error };
}
