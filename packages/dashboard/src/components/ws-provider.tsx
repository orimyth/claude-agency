"use client";

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { WSEvent, WSEventType } from "@/lib/ws-client";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

interface Notification {
  id: string;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message?: string;
  timestamp: number;
  read: boolean;
}

interface WSContextValue {
  connected: boolean;
  events: WSEvent[];
  notifications: Notification[];
  unreadCount: number;
  on: (type: WSEventType, handler: (data: any) => void) => () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  events: [],
  notifications: [],
  unreadCount: 0,
  on: () => () => {},
  markRead: () => {},
  markAllRead: () => {},
  clearNotifications: () => {},
});

export function useGlobalWS() {
  return useContext(WSContext);
}

function createNotification(event: WSEvent): Notification | null {
  const id = `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = Date.now();

  switch (event.type) {
    case "task:update":
      if (event.data.status === "done") {
        return { id, type: "success", title: "Task completed", message: event.data.title || event.data.taskId?.slice(0, 8), timestamp: ts, read: false };
      }
      if (event.data.status === "blocked") {
        return { id, type: "error", title: "Task blocked", message: event.data.title || event.data.taskId?.slice(0, 8), timestamp: ts, read: false };
      }
      if (event.data.status === "in_progress") {
        return { id, type: "info", title: "Task started", message: event.data.title || event.data.taskId?.slice(0, 8), timestamp: ts, read: false };
      }
      return null;
    case "approval:new":
      return { id, type: "warning", title: "Approval needed", message: event.data.title, timestamp: ts, read: false };
    case "break:start":
      return { id, type: "info", title: "Agent on break", message: event.data.agentName || event.data.agentId, timestamp: ts, read: false };
    case "agent:status":
      if (event.data.status === "error") {
        return { id, type: "error", title: "Agent error", message: event.data.agentName || event.data.agentId, timestamp: ts, read: false };
      }
      return null;
    default:
      return null;
  }
}

export function WSProvider({ children }: { children: ReactNode }) {
  const ws = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WSEvent[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const listenersRef = useRef<Map<WSEventType, Set<(data: any) => void>>>(new Map());
  const initialLoadDone = useRef(false);

  useEffect(() => {
    // Mark initial load done after first render cycle
    const timer = setTimeout(() => { initialLoadDone.current = true; }, 2000);

    const connect = () => {
      try {
        const socket = new WebSocket(WS_URL);
        ws.current = socket;

        socket.onopen = () => setConnected(true);
        socket.onclose = () => {
          setConnected(false);
          setTimeout(connect, 3000);
        };
        socket.onerror = () => socket.close();

        socket.onmessage = (evt) => {
          try {
            const event: WSEvent = JSON.parse(evt.data);
            setEvents((prev) => [...prev.slice(-200), event]);

            // Dispatch to listeners
            const listeners = listenersRef.current.get(event.type);
            if (listeners) {
              for (const listener of listeners) {
                listener(event.data);
              }
            }

            // Create notification (skip during initial load to avoid flood)
            if (initialLoadDone.current) {
              const notif = createNotification(event);
              if (notif) {
                setNotifications((prev) => [notif, ...prev].slice(0, 100));
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
    return () => {
      clearTimeout(timer);
      ws.current?.close();
    };
  }, []);

  const on = useCallback((type: WSEventType, handler: (data: any) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(handler);
    return () => {
      listenersRef.current.get(type)?.delete(handler);
    };
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <WSContext.Provider value={{ connected, events, notifications, unreadCount, on, markRead, markAllRead, clearNotifications }}>
      {children}
    </WSContext.Provider>
  );
}
