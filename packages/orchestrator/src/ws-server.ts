import { WebSocketServer, WebSocket } from 'ws';

export type WSEventType =
  | 'agent:status'
  | 'task:update'
  | 'message:new'
  | 'approval:new'
  | 'approval:resolved'
  | 'break:start'
  | 'break:end'
  | 'kpi:update'
  | 'agent:new'
  | 'usage:update'
  | 'emergency:pause'
  | 'emergency:resume'
  | 'deadlock:detected';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Per-client metadata
// ---------------------------------------------------------------------------

interface ClientInfo {
  ws: WebSocket;
  connectedAt: number;
  lastPongAt: number;
  /** If set, only these event types are forwarded to this client. */
  subscribedEvents: Set<WSEventType> | null;
  /** Queued messages when client is slow (backpressure). */
  sendQueue: string[];
  draining: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WSServerOptions {
  /** Max concurrent WebSocket connections. Default: 50. */
  maxConnections?: number;
  /** Heartbeat ping interval in ms. Default: 30_000 (30s). */
  heartbeatIntervalMs?: number;
  /** Time after which a client with no pong is considered dead. Default: 60_000 (60s). */
  pongTimeoutMs?: number;
  /** Max queued messages per slow client before dropping. Default: 100. */
  maxQueueSize?: number;
}

// ---------------------------------------------------------------------------
// Connection stats (exposed for monitoring)
// ---------------------------------------------------------------------------

export interface WSStats {
  activeConnections: number;
  totalConnectionsSinceStart: number;
  totalMessagesBroadcast: number;
  totalMessagesDropped: number;
  totalStaleDisconnects: number;
  totalRejectedConnections: number;
  uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class DashboardWSServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientInfo> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Config
  private maxConnections: number;
  private heartbeatIntervalMs: number;
  private pongTimeoutMs: number;
  private maxQueueSize: number;

  // Stats
  private startedAt = Date.now();
  private totalConnections = 0;
  private totalBroadcasts = 0;
  private totalDropped = 0;
  private totalStaleDisconnects = 0;
  private totalRejected = 0;

  constructor(port: number, opts?: WSServerOptions) {
    this.maxConnections = opts?.maxConnections ?? 50;
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 30_000;
    this.pongTimeoutMs = opts?.pongTimeoutMs ?? 60_000;
    this.maxQueueSize = opts?.maxQueueSize ?? 100;

    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws) => {
      // Reject if at capacity
      if (this.clients.size >= this.maxConnections) {
        this.totalRejected++;
        ws.close(1013, 'Server at capacity');
        return;
      }

      const now = Date.now();
      const info: ClientInfo = {
        ws,
        connectedAt: now,
        lastPongAt: now,
        subscribedEvents: null,
        sendQueue: [],
        draining: false,
      };
      this.clients.set(ws, info);
      this.totalConnections++;

      // Handle pong responses
      ws.on('pong', () => {
        const client = this.clients.get(ws);
        if (client) client.lastPongAt = Date.now();
      });

      // Handle incoming messages (subscribe/unsubscribe commands)
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleClientMessage(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => {
        this.clients.delete(ws);
      });

      // Send welcome with available event types
      ws.send(JSON.stringify({
        type: 'system:welcome',
        data: {
          availableEvents: [
            'agent:status', 'task:update', 'message:new',
            'approval:new', 'approval:resolved',
            'break:start', 'break:end', 'kpi:update',
            'agent:new', 'usage:update',
            'emergency:pause', 'emergency:resume', 'deadlock:detected',
          ],
          maxQueueSize: this.maxQueueSize,
        },
        timestamp: new Date().toISOString(),
      }));
    });

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
  }

  // -------------------------------------------------------------------------
  // Heartbeat: ping all clients, terminate stale ones
  // -------------------------------------------------------------------------

  private heartbeat(): void {
    const now = Date.now();
    for (const [ws, info] of this.clients) {
      if (now - info.lastPongAt > this.pongTimeoutMs) {
        // Client hasn't responded — terminate
        this.totalStaleDisconnects++;
        ws.terminate();
        this.clients.delete(ws);
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Client message handler (subscribe/unsubscribe)
  // -------------------------------------------------------------------------

  private handleClientMessage(ws: WebSocket, msg: { action?: string; events?: string[] }): void {
    const info = this.clients.get(ws);
    if (!info) return;

    if (msg.action === 'subscribe' && Array.isArray(msg.events)) {
      if (!info.subscribedEvents) info.subscribedEvents = new Set();
      for (const ev of msg.events) {
        info.subscribedEvents.add(ev as WSEventType);
      }
    } else if (msg.action === 'unsubscribe' && Array.isArray(msg.events)) {
      if (info.subscribedEvents) {
        for (const ev of msg.events) {
          info.subscribedEvents.delete(ev as WSEventType);
        }
        if (info.subscribedEvents.size === 0) info.subscribedEvents = null;
      }
    } else if (msg.action === 'subscribe_all') {
      info.subscribedEvents = null; // null = receive everything
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast with event filtering + backpressure
  // -------------------------------------------------------------------------

  broadcast(type: WSEventType, data: unknown): void {
    const event: WSEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    const msg = JSON.stringify(event);
    this.totalBroadcasts++;

    for (const [ws, info] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Event filtering: skip if client subscribed to specific events and this isn't one
      if (info.subscribedEvents && !info.subscribedEvents.has(type)) continue;

      // Backpressure: if bufferedAmount is high, queue instead of sending directly
      if (ws.bufferedAmount > 0) {
        if (info.sendQueue.length >= this.maxQueueSize) {
          // Drop oldest message to make room
          info.sendQueue.shift();
          this.totalDropped++;
        }
        info.sendQueue.push(msg);
        this.drainQueue(info);
      } else {
        ws.send(msg);
      }
    }
  }

  private drainQueue(info: ClientInfo): void {
    if (info.draining) return;
    info.draining = true;

    const drain = () => {
      while (info.sendQueue.length > 0 && info.ws.bufferedAmount === 0) {
        const queued = info.sendQueue.shift()!;
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(queued);
        }
      }
      if (info.sendQueue.length > 0 && info.ws.readyState === WebSocket.OPEN) {
        // Still messages to send — wait for drain event
        info.ws.once('drain', drain);
      } else {
        info.draining = false;
      }
    };
    drain();
  }

  // -------------------------------------------------------------------------
  // Stats for monitoring
  // -------------------------------------------------------------------------

  getStats(): WSStats {
    return {
      activeConnections: this.clients.size,
      totalConnectionsSinceStart: this.totalConnections,
      totalMessagesBroadcast: this.totalBroadcasts,
      totalMessagesDropped: this.totalDropped,
      totalStaleDisconnects: this.totalStaleDisconnects,
      totalRejectedConnections: this.totalRejected,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }
}
