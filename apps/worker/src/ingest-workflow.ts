import type { IntakeMessage } from "@shortstop/shared";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

// One instance per notice. Every step must be safe to retry.
export class IngestWorkflow extends WorkflowEntrypoint<Env, IntakeMessage> {
  async run(event: WorkflowEvent<IntakeMessage>, step: WorkflowStep) {
    const { r2Key } = event.payload;

    const text = await step.do("load", async () => {
      // TODO(week 2): PDFs via env.AI.toMarkdown.
      const obj = await this.env.FILES.get(r2Key);
      return obj ? await obj.text() : "";
    });

    await step.do("extract", async () => {
      // TODO(week 2): AI JSON mode → ExtractedNotice.safeParse; failure → needs_triage. Cache in KV by hash.
      return { chars: text.length };
    });

    await step.do("split", async () => {
      // TODO(week 1): deterministic split from packages/shared.
      return null;
    });

    await step.do("apply-policy", async () => {
      // TODO(week 2): policy + hard floors → LotDO.reserveAuto or leave as proposal.
      return null;
    });

    await step.do("notify-board", async () => {
      const board = this.env.BOARD_DO.get(this.env.BOARD_DO.idFromName("desk"));
      await board.broadcast({ type: "notice.ingested", noticeId: event.payload.noticeId });
    });
  }
}
