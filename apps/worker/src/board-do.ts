import type { BoardEvent } from "@shortstop/shared";
import { DurableObject } from "cloudflare:workers";

// One per desk. WebSocket hibernation: idle boards are evicted from memory and cost nothing.
export class BoardDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [req.headers.get("x-shortstop-user") ?? "anonymous"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event: BoardEvent): Promise<number> {
    const msg = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        sent++;
      } catch {
        // Socket already closing; hibernation API will drop it.
      }
    }
    return sent;
  }

  /** Who is looking at the board right now (presence). */
  async viewers(): Promise<string[]> {
    return [...new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws)))];
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }
}
