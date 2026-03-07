"use client";

import { useEffect, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

export function WSStatus() {
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [eventCount, setEventCount] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let mounted = true;

    function connect() {
      if (!mounted) return;
      setStatus("connecting");

      try {
        const socket = new WebSocket(WS_URL);
        ws.current = socket;

        socket.onopen = () => {
          if (mounted) setStatus("connected");
        };

        socket.onmessage = () => {
          if (mounted) setEventCount(c => c + 1);
        };

        socket.onclose = () => {
          if (mounted) {
            setStatus("disconnected");
            reconnectTimer.current = setTimeout(connect, 3000);
          }
        };

        socket.onerror = () => {
          socket.close();
        };
      } catch {
        if (mounted) {
          setStatus("disconnected");
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  const colors = {
    connecting: { dot: "bg-yellow-500 animate-pulse", text: "Connecting..." },
    connected: { dot: "bg-green-500", text: "Connected" },
    disconnected: { dot: "bg-red-500 animate-pulse", text: "Disconnected" },
  };

  const { dot, text } = colors[status];

  return (
    <div className="flex items-center justify-between text-sm text-gray-400">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${dot}`} />
        <span>{text}</span>
      </div>
      {status === "connected" && eventCount > 0 && (
        <span className="text-xs text-gray-500 tabular-nums">{eventCount} events</span>
      )}
    </div>
  );
}
