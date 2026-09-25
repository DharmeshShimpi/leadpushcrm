import { Response } from 'express';

interface SSEClient {
  id: string;
  res: Response;
  secret: string;
}

class SSEService {
  private clients: SSEClient[] = [];

  constructor() {
    // Heartbeat ping every 25 seconds to keep SSE connections alive
    setInterval(() => {
      this.sendHeartbeat();
    }, 25000);
  }

  public addClient(id: string, secret: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client: SSEClient = { id, secret, res };
    this.clients.push(client);

    // Send initial connected ping
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

    res.on('close', () => {
      this.removeClient(id);
    });
  }

  public removeClient(id: string): void {
    this.clients = this.clients.filter(c => c.id !== id);
  }

  private sendHeartbeat(): void {
    const pingData = `event: ping\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`;
    this.clients.forEach(client => {
      try {
        client.res.write(pingData);
      } catch {
        this.removeClient(client.id);
      }
    });
  }

  public broadcast(event: 'dashboard_update' | 'chat_update', data: object = {}): void {
    const appSecret = process.env.APP_SECRET_PATH;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach(client => {
      // Only send to clients belonging to the correct app secret session
      if (appSecret && client.secret !== appSecret) return;
      try {
        client.res.write(payload);
      } catch {
        this.removeClient(client.id);
      }
    });
  }
}

export const sseService = new SSEService();
