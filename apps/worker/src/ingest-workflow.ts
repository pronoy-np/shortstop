import type { ExtractionResult, IntakeMessage } from "@shortstop/shared";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { extractWithCache, loadNoticeText, planLots, setNoticeStatus } from "./ingest";

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
      }),
    );
    return { noticeId, status: planned.length ? "ready" : "needs_triage", planned };
  }
}
