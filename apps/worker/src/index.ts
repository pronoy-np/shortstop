import { IntakeMessage } from "@shortstop/shared";
import { Hono } from "hono";

export { BoardDO } from "./board-do";
export { IngestWorkflow } from "./ingest-workflow";
export { LotDO } from "./lot-do";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ ok: true }));

// TODO(week 1): Access JWT middleware → role lookup in D1.
// TODO(week 1): POST /notices → presigned R2 PUT URL + notices row; POST /notices/:id/submitted → enqueue.

app.get("/board/ws", (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const stub = c.env.BOARD_DO.get(c.env.BOARD_DO.idFromName("desk"));
  return stub.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    if (batch.queue === "shortstop-intake-dlq") {
      // TODO(week 1): mirror into dead_letters in D1, then ack.
      batch.ackAll();
      return;
    }
    for (const msg of batch.messages) {
      const body = IntakeMessage.parse(msg.body);
      // Notice ID as instance ID keeps redelivery idempotent.
      try {
        await env.INGEST_WF.create({ id: body.noticeId, params: body });
      } catch (err) {
        if (!String(err).includes("already exists")) throw err;
      }
      msg.ack();
    }
  },

  async scheduled(controller, _env, _ctx) {
    const at = new Date(controller.scheduledTime);
    const nightly = at.getUTCHours() === 2 && at.getUTCMinutes() < 15;
    // TODO(week 3): sweep stuck reservations/notices; nightly cover re-score + KV snapshot.
    console.log(JSON.stringify({ cron: controller.cron, nightly }));
  },
} satisfies ExportedHandler<Env, IntakeMessage>;
