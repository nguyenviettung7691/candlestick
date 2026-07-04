"use client";

import { useEffect, useRef, useState } from 'react';

import type { DashboardTickerSnapshot, StreamPacket } from '@/lib/types';

interface UseWebSocketOptions {
  url: string;
  dashboardId: string;
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
  return Object.values(rows).every(isDashboardTickerSnapshot);
}

export function useWebSocket({ url, dashboardId }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [lastPacket, setLastPacket] = useState<StreamPacket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    let shouldReconnect = true;

    const clearRetry = () => {
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
        retryRef.current = null;
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

      socket.onopen = () => {
        if (!mounted) {
          return;
        }
        attemptRef.current = 0;
        setConnected(true);
        setConnectionState('connected');
        setError(null);
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

      socket.onclose = () => {
        if (!mounted || socket !== socketRef.current) {
          return;
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      mounted = false;
      shouldReconnect = false;
      clearRetry();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [dashboardId, url]);

  return { connected, connectionState, lastPacket, error };
}
