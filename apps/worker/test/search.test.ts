import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rescoreCover } from "../src/cron";
import { attachPrecedents, fetchPrecedent, indexLots, searchLots } from "../src/search";
import { OPS_LEAD, PLANNER, PLANNER_2, call, lotRow, makeLot } from "./helpers";

const doc = (over: Partial<Parameters<typeof indexLots>[1][number]> = {}) => ({
  lotId: "n_x-1",
  noticeId: "n_x",
  drugId: "cisplatin",
  drugName: "Cisplatin",
  drugClass: "oncology",
  wholesaler: "Northstar",
  quantity: 150,
  unit: "vial",
  eta: "2026-11-13",
  explanation: "Split across 6 sites.",
  ...over,
});

function fakeVectors() {
  const store = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  return {
    store,
    ai: { run: async (_m: string, input: Record<string, unknown>) => ({ data: (input.text as string[]).map((t) => [t.length % 7, 1, 0.5]) }) },
    vec: ({
      upsert: async (vs: VectorizeVector[]) => {
        for (const v of vs) store.set(v.id, { values: v.values as number[], metadata: v.metadata as Record<string, unknown> });
        return { mutationId: "m" } as unknown as VectorizeAsyncMutation;
      },
      query: async () =>
        ({ count: store.size, matches: [...store.entries()].map(([id, v], i) => ({ id, score: 0.9 - i * 0.1, metadata: v.metadata })) }) as unknown as VectorizeMatches,
    }) as unknown as Pick<VectorizeIndex, "upsert" | "query">,
  };
}

describe("Vectorize: index and search by meaning", () => {
  it("upserts one vector per lot with its summary as metadata, idempotently", async () => {
    const f = fakeVectors();
    expect(await indexLots(f, [doc(), doc({ lotId: "n_x-2", drugName: "Carboplatin" })])).toBe(2);
    expect(await indexLots(f, [doc()])).toBe(1);
    expect(f.store.size).toBe(2);
    expect(f.store.get("n_x-1")!.metadata).toMatchObject({ noticeId: "n_x", drugId: "cisplatin" });
    expect(String(f.store.get("n_x-1")!.metadata.summary)).toContain("150 vials allocated by Northstar");
  });

  it("searchLots returns ranked hits with summaries", async () => {
    const f = fakeVectors();
    await indexLots(f, [doc(), doc({ lotId: "n_x-2" })]);
    const hits = await searchLots(f, "platinum chemo shortage");
    expect(hits.map((h) => h.lotId)).toEqual(["n_x-1", "n_x-2"]);
    expect(hits[0]!.score).toBe(0.9);
  });

  it("/api/search validates the query and degrades to 503 when the index is unreachable", async () => {
    expect((await call("/api/search?q=a", { as: PLANNER })).status).toBe(400);
    // Locally Vectorize is not available (remoteBindings: false): the route must fail soft, not 500.
    expect((await call("/api/search?q=platinum%20chemo", { as: PLANNER })).status).toBe(503);
  });
});

describe("RAG precedent via the AI Worker service binding", () => {
  it("attaches a grounded note to a lot and audits it", async () => {
    const { lotId, noticeId } = await makeLot({ drugId: "cisplatin" });
    expect(await attachPrecedents(env, [doc({ lotId, noticeId })])).toBe(1);
    expect(await lotRow(lotId)).toMatchObject({
      precedent_note: "Last cycle this wholesaler shipped less than half the order [1].",
      precedent_sources_json: '["n_past-1"]',
    });
    const a = await env.DB.prepare(`SELECT actor FROM audit_log WHERE id = ?`).bind(`lot:${lotId}:precedent`).first();
    expect(a).toEqual({ actor: "ai-worker" });
  });

  it("an AI Worker failure or a missing secret returns null and never throws", async () => {
    expect(await fetchPrecedent(env, doc({ explanation: "AI-DOWN" }))).toBeNull();
    const { AI_SHARED_SECRET: _, ...noSecret } = env as Env;
    expect(await fetchPrecedent(noSecret as Env, doc())).toBeNull();
    const { lotId, noticeId } = await makeLot();
    expect(await attachPrecedents(env, [doc({ lotId, noticeId, explanation: "AI-DOWN" })])).toBe(0);
    expect((await lotRow(lotId))!.precedent_note).toBeNull();
  });
});

describe("Cluster E: idempotency and run-twice safety", () => {
  it("Idempotency-Key header: a replay returns the original result and writes nothing new", async () => {
    const { lotId } = await makeLot({ quantity: 100 });
    const commit = () =>
      call(`/api/lots/${lotId}/commit`, {
        method: "POST",
        as: PLANNER,
        headers: { "Idempotency-Key": "idem-key-0001" },
        json: { allocations: [{ siteId: "rci", quantity: 40 }] },
      });
    expect(await (await commit()).json()).toMatchObject({ ok: true, available: 60, replay: false });
    expect(await (await commit()).json()).toMatchObject({ ok: true, available: 60, replay: true });
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM allocations WHERE lot_id = ?`).bind(lotId).first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect((await call(`/api/lots/${lotId}/commit`, { method: "POST", as: PLANNER, json: { allocations: [{ siteId: "rci", quantity: 1 }] } })).status).toBe(400);
  });

  it("a losing commit is traced in the audit log with outcome rejected", async () => {
    const { lotId } = await makeLot({ quantity: 50 });
    const body = (k: string) => ({ method: "POST", headers: { "Idempotency-Key": k }, json: { allocations: [{ siteId: "rci", quantity: 50 }] } });
    expect((await call(`/api/lots/${lotId}/commit`, { ...body("win-key-001"), as: PLANNER })).status).toBe(200);
    expect((await call(`/api/lots/${lotId}/commit`, { ...body("lose-key-001"), as: PLANNER_2 })).status).toBe(409);
    const row = await env.DB.prepare(`SELECT action, actor FROM audit_log WHERE id = ?`).bind(`lot:${lotId}:rejected:lose-key-001`).first();
    expect(row).toEqual({ action: "lot.commit_rejected", actor: PLANNER_2 });
  });

  it("the nightly re-score UPSERTs: running it twice leaves identical rows", async () => {
    const now = Date.UTC(2026, 10, 4, 2, 0);
    await rescoreCover(env, now);
    const first = await env.DB.prepare(`SELECT * FROM cover_history WHERE day = '2026-11-04' ORDER BY site_id, drug_id`).all();
    await rescoreCover(env, now);
    const second = await env.DB.prepare(`SELECT * FROM cover_history WHERE day = '2026-11-04' ORDER BY site_id, drug_id`).all();
    expect(first.results.length).toBeGreaterThan(300);
    expect(second.results).toEqual(first.results);
    expect((await call("/api/metrics", { as: OPS_LEAD })).status).toBe(200);
  });
});
