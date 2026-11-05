import { z } from "zod";
import { workersAi } from "../lib/ai";
import { searchLots } from "../search";

const SearchQuery = z.object({ q: z.string().trim().min(2).max(200), k: z.coerce.number().int().min(1).max(20).default(8) });

export type SearchHitView = {
  lotId: string;
  score: number;
  summary: string;
  lot: { id: string; noticeId: string; status: string; quantity: number; remaining: number; drugName: string };
};

/**
 * Search lots by meaning (Workers AI embeddings + Vectorize), joined to the lots that still exist in D1.
 * Input: `{ q, k? }` (strings coerced, as from a query string). Search is advisory: when the model or index is down it
 * returns `unavailable` instead of throwing.
 */
export async function searchBoard(
  env: Env,
  input: unknown,
): Promise<{ ok: true; hits: SearchHitView[] } | { ok: false; code: "invalid" | "unavailable"; message: string }> {
  const q = SearchQuery.safeParse(input ?? {});
  if (!q.success) return { ok: false, code: "invalid", message: "q must be 2-200 characters" };
  let hits;
  try {
    hits = await searchLots({ ai: workersAi(env), vec: env.VEC }, q.data.q, q.data.k);
  } catch (err) {
    console.warn("search unavailable", err);
    return { ok: false, code: "unavailable", message: "search is temporarily unavailable" };
  }
  const ids = hits.map((h) => h.lotId);
  const { results } = ids.length
    ? await env.DB.prepare(
        `SELECT l.id, l.notice_id AS noticeId, l.status, l.quantity, l.remaining, d.name AS drugName
           FROM lots l JOIN drugs d ON d.id = l.drug_id WHERE l.id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<SearchHitView["lot"]>()
    : { results: [] as SearchHitView["lot"][] };
  const byId = new Map(results.map((r) => [r.id, r]));
  // Vectors can outlive a reseeded D1; only return lots that still exist.
  return { ok: true, hits: hits.flatMap((h) => (byId.has(h.lotId) ? [{ ...h, lot: byId.get(h.lotId)! }] : [])) };
}
