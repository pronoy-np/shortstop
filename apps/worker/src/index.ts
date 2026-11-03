import { IntakeMessage } from "@shortstop/shared";
import { api } from "./api";
import { rescoreCover, sweep } from "./cron";
import { audit } from "./lib/audit";
import { setNoticeStatus } from "./ingest";

export { BoardDO } from "./board-do";
export { IngestWorkflow } from "./ingest-workflow";
export { LotDO } from "./lot-do";

const DLQ = "shortstop-intake-dlq";

export default {
  fetch: api.fetch,

  async queue(batch, env, _ctx) {
    for (const msg of batch.messages) {
      const parsed = IntakeMessage.safeParse(msg.body);

      if (batch.queue === DLQ) {
        // Mirror dead letters into D1 so they are visible in the app, then give up on the notice.
        await env.DB.prepare(`INSERT OR IGNORE INTO dead_letters (id, queue, body_json, attempts, at) VALUES (?, ?, ?, ?, ?)`)
          .bind(msg.id, batch.queue, JSON.stringify(msg.body), msg.attempts, Date.now())
          .run();
        if (parsed.success) await setNoticeStatus(env, parsed.data.noticeId, "failed", { error: "intake retries exhausted" });
        msg.ack();
        continue;
      }

      if (!parsed.success) {
        await audit(env, { entity: "system", entityId: msg.id, action: "queue.bad_message", actor: "queue", payload: msg.body });
        msg.ack();
        continue;
      }
      try {
        // Notice id as the instance id keeps redelivery idempotent.
        await env.INGEST_WF.create({ id: parsed.data.noticeId, params: parsed.data });
        msg.ack();
      } catch (err) {
        if (String(err).includes("already")) msg.ack();
        else msg.retry({ delaySeconds: 10 });
      }
    }
  },

  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime);
    const result = await sweep(env, controller.scheduledTime);
    if (at.getUTCHours() === 2 && at.getUTCMinutes() < 15) await rescoreCover(env, controller.scheduledTime);
    console.log(JSON.stringify({ cron: controller.cron, ...result }));
  },
} satisfies ExportedHandler<Env, unknown>;
