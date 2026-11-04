import type { ExtractionResult, IntakeMessage } from "@shortstop/shared";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { extractWithCache, loadNoticeText, planLots, setNoticeStatus } from "./ingest";
import { broadcast } from "./lib/board";
import { attachPrecedents, indexLots, loadLotDocs } from "./search";

const retries = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } } as const;

// One instance per notice (instance id = notice id). Every step is idempotent and safe to retry.
export class IngestWorkflow extends WorkflowEntrypoint<Env, IntakeMessage> {
  async run(event: WorkflowEvent<IntakeMessage>, step: WorkflowStep) {
    const { noticeId, r2Key, contentType } = event.payload;

    await step.do("mark-processing", () => setNoticeStatus(this.env, noticeId, "processing"));

    const text = await step.do("load", retries, () => loadNoticeText(this.env, r2Key, contentType));

    const extraction: ExtractionResult = await step.do("extract", retries, () => extractWithCache(this.env, text));

    if (!extraction.ok) {
      await step.do("triage", () => setNoticeStatus(this.env, noticeId, "needs_triage", { error: extraction.reason }));
      return { noticeId, status: "needs_triage", reason: extraction.reason };
    }

    const planned = await step.do("plan-lots", retries, () => planLots(this.env, noticeId, extraction));

    await step.do("mark-ready", () =>
      setNoticeStatus(this.env, noticeId, planned.length ? "ready" : "needs_triage", {
        wholesaler: extraction.wholesaler,
        noticeRef: extraction.noticeRef,
        confidence: extraction.confidence,
        error: extraction.warnings.join("; ") || (planned.length ? null : "no catalog drugs matched"),
        lots: planned.length,
      }),
    );

    // Advisory AI after the lots are already on the board: failures are swallowed so they never block allocation.
    // Precedents first, so this notice's own lots are not yet in the index.
    const precedents = await step.do("precedents", async () => {
      try {
        const n = await attachPrecedents(this.env, await loadLotDocs(this.env, noticeId));
        if (n > 0) await broadcast(this.env, { type: "notice.enriched", noticeId, precedents: n });
        return n;
      } catch (err) {
        console.warn("precedents skipped", err);
        return 0;
      }
    });

    const indexed = await step.do("index-lots", async () => {
      try {
        return await indexLots({ ai: this.env.AI as never, vec: this.env.VEC }, await loadLotDocs(this.env, noticeId));
      } catch (err) {
        console.warn("vector indexing skipped", err);
        return 0;
      }
    });

    return { noticeId, status: planned.length ? "ready" : "needs_triage", planned, precedents, indexed };
  }
}
