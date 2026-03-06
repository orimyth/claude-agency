"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type WSEventType =
  | "agent:status"
  | "task:update"
  | "message:new"
  | "approval:new"
  | "approval:resolved"
  | "break:start"
  | "break:end"
  | "kpi:update";

export interface WSEvent {
  type: WSEventType;
  data: any;
  timestamp: string;
}

export function useWebSocket(url: string) {
  const ws = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WSEvent[]>([]);
  const listenersRef = useRef<Map<WSEventType, Set<(data: any) => void>>>(
    new Map()
  );

  useEffect(() => {
    const connect = () => {
      try {
        ws.current = new WebSocket(url);

        ws.current.onopen = () => setConnected(true);
        ws.current.onclose = () => {
          setConnected(false);
          setTimeout(connect, 3000);
        };
        ws.current.onerror = () => ws.current?.close();

        ws.current.onmessage = (evt) => {
          try {
            const event: WSEvent = JSON.parse(evt.data);
            setEvents((prev) => [...prev.slice(-200), event]);

            const listeners = listenersRef.current.get(event.type);
            if (listeners) {
              for (const listener of listeners) {
                listener(event.data);
              }
            }
          } catch {
            // ignore parse errors
          }
        };
      } catch {
        setTimeout(connect, 3000);
      }
    };

    connect();
    return () => ws.current?.close();
  }, [url]);

  const on = useCallback((type: WSEventType, handler: (data: any) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(handler);
    return () => {
      listenersRef.current.get(type)?.delete(handler);
    };
  }, []);

  return { connected, events, on };
}
