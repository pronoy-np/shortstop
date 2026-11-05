import { z } from "zod";
import { batchAudited } from "./lib/audit";
import { planLots } from "./ingest";

/**
 * Test-only fixture for `pnpm test:e2e`: the e2e env has no queue consumer and no AI binding, so a notice can never be
 * extracted there. This plans lots exactly as the pipeline does after extraction (same `planLots`, same LotDO init),
 * from a stated drug and quantity. It answers only when `E2E_SEED` is "true", which only the wrangler `e2e` env sets;
 * everywhere else the request falls through to the API's 401/404.
 */
const SeedBody = z.object({ drugId: z.string().max(60).default("cisplatin"), quantity: z.number().int().min(1).max(100_000).default(150) });

export async function e2eSeed(env: Env, req: Request): Promise<Response> {
  const body = SeedBody.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "bad seed body" }, { status: 400 });
  const noticeId = `n_e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await batchAudited(
    env,
    [
      env.DB.prepare(
        `INSERT INTO notices (id, r2_key, filename, content_type, status, wholesaler, created_by, created_at)
         VALUES (?, ?, 'e2e.txt', 'text/plain', 'ready', 'E2E Wholesale', 'e2e', ?)`,
      ).bind(noticeId, `notices/${noticeId}/e2e.txt`, Date.now()),
    ],
    [{ id: `notice:${noticeId}:received`, entity: "notice", entityId: noticeId, action: "notice.received", actor: "e2e", payload: { filename: "e2e.txt" } }],
  );
  const lots = await planLots(env, noticeId, {
    ok: true,
    wholesaler: "E2E Wholesale",
    noticeRef: null,
    confidence: 1,
    lots: [{ drugId: body.data.drugId, drugName: body.data.drugId, quantity: body.data.quantity, unit: "unit", eta: null }],
    warnings: [],
  });
  return Response.json({ noticeId, lots });
}
