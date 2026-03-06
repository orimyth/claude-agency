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
  | 'agent:new';

export interface WSEvent {
  type: WSEventType;
  data: any;
  timestamp: string;
}

export class DashboardWSServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  broadcast(type: WSEventType, data: any): void {
    const event: WSEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    const msg = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.wss.close();
  }
}
