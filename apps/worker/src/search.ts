import { EMBEDDING_MODEL, EmbeddingOutput, PrecedentResponse, lotSummary, type LotDoc } from "@shortstop/shared";
import { batchAudited } from "./lib/audit";

type Embedder = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
type Index = Pick<VectorizeIndex, "upsert" | "query">;

const PRECEDENT_TIMEOUT_MS = 8_000;

export async function embed(ai: Embedder, texts: string[]): Promise<number[][]> {
  const out = EmbeddingOutput.safeParse(await ai.run(EMBEDDING_MODEL, { text: texts }));
  if (!out.success || out.data.data.length !== texts.length) throw new Error("embedding failed");
  return out.data.data;
}

export async function loadLotDocs(env: Env, noticeId: string): Promise<LotDoc[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.id AS lotId, l.notice_id AS noticeId, l.drug_id AS drugId, d.name AS drugName, d.drug_class AS drugClass,
            COALESCE(n.wholesaler, 'unknown wholesaler') AS wholesaler, l.quantity, d.unit, l.eta, l.explanation
       FROM lots l JOIN drugs d ON d.id = l.drug_id JOIN notices n ON n.id = l.notice_id
      WHERE l.notice_id = ? ORDER BY l.id`,
  )
    .bind(noticeId)
    .all<LotDoc>();
  return results;
}

/** Upserts one vector per lot (id = lot id, so re-indexing is idempotent). The summary rides along for RAG. */
export async function indexLots(deps: { ai: Embedder; vec: Index }, docs: LotDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  const summaries = docs.map(lotSummary);
  const vectors = await embed(deps.ai, summaries);
  await deps.vec.upsert(
    docs.map((d, i) => ({
      id: d.lotId,
      values: vectors[i]!,
      metadata: { noticeId: d.noticeId, drugId: d.drugId, wholesaler: d.wholesaler, summary: summaries[i]! },
    })),
  );
  return docs.length;
}

export type SearchHit = { lotId: string; score: number; summary: string };

/** Search lots by meaning: "platinum chemo shortfall", "pediatric antibiotics from Coastal"... */
export async function searchLots(deps: { ai: Embedder; vec: Index }, q: string, topK = 8): Promise<SearchHit[]> {
  const [vector] = await embed(deps.ai, [q]);
  const res = await deps.vec.query(vector!, { topK, returnMetadata: "all" });
  return res.matches.map((m) => ({ lotId: m.id, score: Math.round(m.score * 1000) / 1000, summary: String(m.metadata?.summary ?? "") }));
}

/**
 * Asks the RAG Worker (service binding, shared secret) for a precedent note. Any failure or timeout
 * returns null: the AI is advisory and must never block or fail the allocation pipeline.
 */
export async function fetchPrecedent(env: Env, doc: LotDoc): Promise<PrecedentResponse | null> {
  if (!env.AI_SHARED_SECRET) return null;
  try {
    const res = await env.AI_SVC.fetch("https://shortstop-ai/precedent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shortstop-secret": env.AI_SHARED_SECRET },
      body: JSON.stringify({ lotId: doc.lotId, noticeId: doc.noticeId, text: lotSummary(doc) }),
      signal: AbortSignal.timeout(PRECEDENT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = PrecedentResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn("precedent unavailable", err);
    return null;
  }
}

/** Stores precedent notes on the lots (audited). Lots without a grounded note are left untouched. */
export async function attachPrecedents(env: Env, docs: LotDoc[]): Promise<number> {
  let attached = 0;
  for (const doc of docs) {
    const p = await fetchPrecedent(env, doc);
    if (!p?.note) continue;
    await batchAudited(
      env,
      [
        env.DB.prepare(`UPDATE lots SET precedent_note = ?, precedent_sources_json = ? WHERE id = ?`).bind(
          p.note,
          JSON.stringify(p.sources),
          doc.lotId,
        ),
      ],
      [{ id: `lot:${doc.lotId}:precedent`, entity: "lot", entityId: doc.lotId, action: "lot.precedent_attached", actor: "ai-worker", payload: p }],
    );
    attached++;
  }
  return attached;
}
