import type { BoardEvent } from "@shortstop/shared";
import { DurableObject } from "cloudflare:workers";

// One per desk. Uses WebSocket hibernation so idle boards cost nothing.
export class BoardDO extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event: BoardEvent): Promise<void> {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) ws.send(msg);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}
