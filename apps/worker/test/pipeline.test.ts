import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { extractNotice, type ExtractionResult } from "@shortstop/shared";
import expected from "../../../fixtures/notices/expected.json";
import type { EvalCase } from "../evals/score";
import { describe, expect, it } from "vitest";
import { rescoreCover, sweep } from "../src/cron";
import { extractWithCache, loadCatalog, loadNoticeText, planLots } from "../src/ingest";
import worker from "../src/index";
import { PLANNER, call, lotRow, makeLot, uid } from "./helpers";

type Ok = Extract<ExtractionResult, { ok: true }>;

const extraction = (lots: Ok["lots"], confidence = 0.95): Ok => ({
  ok: true,
  wholesaler: "Meridian Health Supply",
  noticeRef: "ALLOC-7781",
  confidence,
  lots,
  warnings: [],
});

const lot = (drugId: string, quantity: number) => ({ drugId, drugName: drugId, quantity, unit: "vial", eta: "2026-11-12" });

async function notice() {
  const id = uid("n");
  await env.DB.prepare(
    `INSERT INTO notices (id, r2_key, filename, content_type, status, created_by, created_at) VALUES (?, 'k', 'f', 'text/plain', 'processing', ?, ?)`,
  )
    .bind(id, PLANNER, Date.now())
    .run();
  return id;
}

describe("planLots (policy + hard floors + autopilot)", () => {
  it("routes each lot by policy: tier-1 manual, antibiotic proposed, small confident lot reserved", async () => {
    const id = await notice();
    const planned = await planLots(env, id, extraction([lot("cisplatin", 120), lot("cefazolin", 300), lot("ondansetron", 200)]));
    expect(planned.map((p) => [p.drugId, p.action, p.ruleId, p.reserved])).toEqual([
      ["cisplatin", "manual_only", "tier1-manual", false],
      ["cefazolin", "propose", "antibiotics-propose", false],
      ["ondansetron", "auto_commit", "small-confident-auto", true],
    ]);
    expect(await lotRow(`${id}-3`)).toMatchObject({ status: "reserved", policy_version: 1, rule_id: "small-confident-auto" });
    const proposal = JSON.parse(String((await lotRow(`${id}-1`))!.proposal_json));
    expect(proposal.allocations.reduce((s: number, a: { quantity: number }) => s + a.quantity, 0)).toBe(120);
  });

  it("low confidence keeps a small lot out of autopilot", async () => {
    const id = await notice();
    const [p] = await planLots(env, id, extraction([lot("ondansetron", 200)], 0.6));
    expect(p).toMatchObject({ action: "propose", reserved: false });
  });

  it("hard floor holds even if the ops lead tries to automate everything", async () => {
    await env.DB.prepare(`INSERT INTO policy_versions (version, rules_json, created_by, created_at) VALUES (999, ?, 'olu@shortstop.demo', 0)`)
      .bind(JSON.stringify([{ id: "everything", when: {}, then: "auto_commit" }]))
      .run();
    try {
      const id = await notice();
      const [p] = await planLots(env, id, extraction([lot("epinephrine-syr", 40)]));
      expect(p).toMatchObject({ action: "propose", ruleId: "everything", hardFloor: "tier1", reserved: false });
    } finally {
      await env.DB.prepare(`DELETE FROM policy_versions WHERE version = 999`).run();
    }
  });

  it("a split that leaves sites short suggests a substitute and needs a pharmacist", async () => {
    const before = await env.DB.prepare(`SELECT on_hand FROM stock WHERE drug_id = 'amoxicillin-susp' AND site_id = 'lch'`).first<{ on_hand: number }>();
    await env.DB.prepare(`UPDATE stock SET on_hand = 0 WHERE drug_id = 'amoxicillin-susp' AND site_id = 'lch'`).run();
    try {
      const id = await notice();
      const [p] = await planLots(env, id, extraction([lot("amoxicillin-susp", 5)]));
      expect(p!.reserved).toBe(false);
      expect(await lotRow(`${id}-1`)).toMatchObject({ status: "needs_pharmacist", substitute_id: "cefdinir-susp", substitute_status: "pending" });
    } finally {
      await env.DB.prepare(`UPDATE stock SET on_hand = ? WHERE drug_id = 'amoxicillin-susp' AND site_id = 'lch'`).bind(before!.on_hand).run();
    }
  });

  it("a well-stocked network needs no substitute", async () => {
    await env.DB.prepare(`UPDATE stock SET on_hand = on_hand + 100000 WHERE drug_id = 'furosemide'`).run();
    try {
      const id = await notice();
      await planLots(env, id, extraction([lot("furosemide", 5)]));
      expect(await lotRow(`${id}-1`)).toMatchObject({ substitute_id: null, substitute_status: null });
    } finally {
      await env.DB.prepare(`UPDATE stock SET on_hand = on_hand - 100000 WHERE drug_id = 'furosemide'`).run();
    }
  });

  it("is idempotent when the step is retried", async () => {
    const id = await notice();
    const ex = extraction([lot("ondansetron", 100)]);
    await planLots(env, id, ex);
    await planLots(env, id, ex);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM lots WHERE notice_id = ?`).bind(id).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("extraction cache and loaders", () => {
  it("caches extraction by content hash so retries spend no neurons", async () => {
    let calls = 0;
    const ai = {
      run: async () => {
        calls++;
        return { response: { isAllocationNotice: true, wholesaler: "W", noticeRef: null, confidence: 0.9, lots: [lot("cisplatin", 10)] } };
      },
    };
    const text = `Allocation notice ${uid("t")}: cisplatin 10 vials`;
    const a = await extractWithCache(env, text, ai);
    const b = await extractWithCache(env, text, ai);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("reads .eml notices with postal-mime", async () => {
    const eml = [
      "From: allocations@meridian.example",
      "To: pharmacy@riverbend.example",
      "Subject: Allocation update ALLOC-1",
      "Content-Type: text/plain",
      "",
      "Your allocation for cisplatin is 80 vials.",
    ].join("\r\n");
    await env.FILES.put("notices/t/a.eml", eml);
    const text = await loadNoticeText(env, "notices/t/a.eml", "message/rfc822");
    expect(text).toContain("Subject: Allocation update ALLOC-1");
    expect(text).toContain("80 vials");
  });
});

describe("IngestWorkflow end to end", () => {
  it("upload → queue → workflow → lots on the board (AI step mocked)", async () => {
    await using wf = await introspectWorkflow(env.INGEST_WF);
    await wf.modifyAll(async (m) => {
      await m.mockStepResult({ name: "extract" }, extraction([lot("cisplatin", 90), lot("ondansetron", 150)]));
    });

    const form = new FormData();
    form.set("text", "Meridian allocation ALLOC-7781: cisplatin 90 vials, ondansetron 150 vials, ship 2026-11-12");
    const res = await call("/api/notices", { method: "POST", as: PLANNER, body: form });
    expect(res.status).toBe(202);
    const { noticeId } = await res.json<{ noticeId: string }>();

    // The queue consumer starts the workflow; drive it here so the test does not depend on queue timing.
    const r2Key = (await env.DB.prepare(`SELECT r2_key FROM notices WHERE id = ?`).bind(noticeId).first<{ r2_key: string }>())!.r2_key;
    const batch = createMessageBatch("shortstop-intake", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { noticeId, r2Key, contentType: "text/plain" } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["m1"]);

    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toMatchObject({ status: "ready" });

    // Redelivery of the same message is recognised by state (the instance exists), not by error text.
    const again = createMessageBatch("shortstop-intake", [{ id: "m2", timestamp: new Date(), attempts: 2, body: { noticeId, r2Key, contentType: "text/plain" } }]);
    const ctx2 = createExecutionContext();
    await worker.queue(again, env, ctx2);
    expect((await getQueueResult(again, ctx2)).explicitAcks).toEqual(["m2"]);

    const n = await env.DB.prepare(`SELECT status, wholesaler, confidence FROM notices WHERE id = ?`).bind(noticeId).first();
    expect(n).toMatchObject({ status: "ready", wholesaler: "Meridian Health Supply", confidence: 0.95 });
    const board = await (await call("/api/board", { as: PLANNER })).json<{ notices: { id: string; lots: { status: string }[] }[] }>();
    expect(board.notices.find((x) => x.id === noticeId)!.lots.map((l) => l.status)).toEqual(["open", "reserved"]);

    // ...and all the way to a confirmation in R2: a planner commits the tier-1 lot.
    const lotId = `${noticeId}-1`;
    const proposal = await (await call(`/api/lots/${lotId}/proposal`, { as: PLANNER })).json<{ proposal: { allocations: { siteId: string; quantity: number }[] } }>();
    const commit = await call(`/api/lots/${lotId}/commit`, { method: "POST", as: PLANNER, json: { commitKey: "e2e-commit-1", allocations: proposal.proposal.allocations } });
    expect(commit.status).toBe(200);
    expect(await lotRow(lotId)).toMatchObject({ status: "committed", remaining: 0 });
    const html = await call(`/api/files?key=${encodeURIComponent(`confirmations/${lotId}/e2e-commit-1.html`)}`, { as: PLANNER });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Cisplatin");
    const csv = await env.FILES.get(`confirmations/${lotId}/e2e-commit-1.csv`);
    expect((await csv!.text()).split("\n").length).toBe(proposal.proposal.allocations.length + 1);
  });

  it("a notice the model rejects lands in needs_triage", async () => {
    await using wf = await introspectWorkflow(env.INGEST_WF);
    await wf.modifyAll(async (m) => {
      await m.mockStepResult({ name: "extract" }, { ok: false, reason: "not an allocation notice" });
    });
    const id = await notice();
    await env.FILES.put("notices/x/menu.txt", "Lunch menu for Friday");
    await env.INGEST_WF.create({ id, params: { noticeId: id, r2Key: "notices/x/menu.txt", contentType: "text/plain" } });
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await env.DB.prepare(`SELECT status, error FROM notices WHERE id = ?`).bind(id).first()).toEqual({
      status: "needs_triage",
      error: "not an allocation notice",
    });
  });
});

describe("queue + cron", () => {
  it("dead letters are mirrored to D1 and the notice is failed", async () => {
    const id = await notice();
    const batch = createMessageBatch("shortstop-intake-dlq", [{ id: `dl-${id}`, timestamp: new Date(), attempts: 4, body: { noticeId: id, r2Key: "k", contentType: "text/plain" } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    await getQueueResult(batch, ctx);
    expect(await env.DB.prepare(`SELECT attempts FROM dead_letters WHERE id = ?`).bind(`dl-${id}`).first()).toEqual({ attempts: 4 });
    expect(await lotNoticeStatus(id)).toBe("failed");
    expect(await env.DB.prepare(`SELECT action FROM audit_log WHERE id = ?`).bind(`dlq:dl-${id}`).first()).toEqual({ action: "queue.dead_letter" });
  });

  it("sweep finalises reservations whose alarm was missed", async () => {
    const { lotId, stub } = await makeLot({ drugId: "ondansetron", quantity: 50 });
    await stub.reserveAuto({ commitKey: `auto:${lotId}`, allocations: [{ siteId: "rci", quantity: 50 }], ruleId: "r", policyVersion: 1, windowMs: 1000 });
    const res = await sweep(env, Date.now() + 5 * 60_000);
    expect(res.finalized).toBeGreaterThanOrEqual(1);
    expect(await lotRow(lotId)).toMatchObject({ status: "committed", remaining: 0 });
  });

  it("nightly re-score writes the cover snapshot to KV", async () => {
    const snap = await rescoreCover(env);
    expect(snap.lowest.length).toBe(15);
    expect(await env.CACHE.get("cover:snapshot", "json")).toMatchObject({ generatedAt: snap.generatedAt });
  });
});

async function lotNoticeStatus(id: string) {
  return (await env.DB.prepare(`SELECT status FROM notices WHERE id = ?`).bind(id).first<{ status: string }>())?.status;
}

// The real fixture files through the real loaders (R2 → postal-mime / text) and validation, with the model mocked
// to answer the ground truth. The live model is scored separately by `pnpm eval`.
const fixtures = import.meta.glob<string>("../../../fixtures/notices/*.{txt,eml}", { query: "?raw", import: "default", eager: true });

describe("fixtures through loaders + validation (mocked AI)", () => {
  for (const c of (expected as { cases: EvalCase[] }).cases.filter((x) => !x.triage && !x.file.endsWith(".pdf"))) {
    it(c.file, async () => {
      const key = `notices/fixture/${c.file}`;
      await env.FILES.put(key, fixtures[`../../../fixtures/notices/${c.file}`]!);
      const text = await loadNoticeText(env, key, c.contentType);
      for (const l of c.lots!) expect(text).toContain(String(l.quantity).replace(/(\d)(?=(\d{3})+$)/g, "$1,").slice(-3));

      const ai = {
        run: async (_model: string, input: Record<string, unknown>) => {
          expect((input.messages as { content: string }[])[1]!.content).toContain(text.slice(0, 40));
          return { response: { isAllocationNotice: true, wholesaler: `${c.wholesaler} Inc`, noticeRef: null, confidence: 0.9, lots: c.lots!.map((l) => ({ drugName: l.drugId, unit: "unit", ...l })) } };
        },
      };
      const r = await extractNotice(ai, text, await loadCatalog(env));
      expect(r.ok && r.lots.map((l) => [l.drugId, l.quantity, l.eta])).toEqual(c.lots!.map((l) => [l.drugId, l.quantity, l.eta]));
    });
  }
});
