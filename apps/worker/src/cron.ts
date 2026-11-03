import { auditStmt } from "./lib/audit";
import { setNoticeStatus } from "./ingest";

const STALE_NOTICE_MS = 30 * 60_000;

/** Every 15 min: finalise reservations whose alarm was missed, fail notices whose workflow died. */
export async function sweep(env: Env, now = Date.now()) {
  const { results: due } = await env.DB.prepare(`SELECT id FROM lots WHERE status = 'reserved' AND finalizes_at < ?`)
    .bind(now - 60_000)
    .all<{ id: string }>();
  let finalized = 0;
  for (const { id } of due) if (await env.LOT_DO.get(env.LOT_DO.idFromName(id)).finalizeIfDue(now)) finalized++;

  const { results: stuck } = await env.DB.prepare(
    `SELECT id FROM notices WHERE status IN ('received', 'processing') AND created_at < ?`,
  )
    .bind(now - STALE_NOTICE_MS)
    .all<{ id: string }>();
  let failed = 0;
  for (const { id } of stuck) {
    let state = "unknown";
    try {
      state = (await (await env.INGEST_WF.get(id)).status()).status;
    } catch {
      state = "missing";
    }
    if (["errored", "terminated", "missing"].includes(state)) {
      await setNoticeStatus(env, id, "failed", { error: `workflow ${state}` });
      failed++;
    }
  }
  return { finalized, failed };
}

export type CoverSnapshot = {
  generatedAt: number;
  lowest: { siteId: string; siteName: string; drugId: string; drugName: string; tier: number; cover: number }[];
};

/** Nightly: re-score days of cover across the network into one KV snapshot (1 KV write/day). */
export async function rescoreCover(env: Env, now = Date.now()): Promise<CoverSnapshot> {
  const { results } = await env.DB.prepare(
    `SELECT s.site_id AS siteId, si.name AS siteName, s.drug_id AS drugId, d.name AS drugName, d.tier AS tier,
            ROUND((s.on_hand + s.inbound + COALESCE((SELECT SUM(a.quantity) FROM allocations a JOIN lots l ON l.id = a.lot_id
                    WHERE a.site_id = s.site_id AND l.drug_id = s.drug_id), 0)) / s.daily_demand, 1) AS cover
       FROM stock s JOIN sites si ON si.id = s.site_id JOIN drugs d ON d.id = s.drug_id
      WHERE s.daily_demand > 0
      ORDER BY cover ASC, d.tier ASC LIMIT 15`,
  ).all<CoverSnapshot["lowest"][number]>();
  const snapshot = { generatedAt: now, lowest: results };
  await env.CACHE.put("cover:snapshot", JSON.stringify(snapshot));
  await auditStmt(env, { entity: "system", entityId: "cron", action: "cover.rescored", actor: "cron", payload: { rows: results.length } }).run();
  return snapshot;
}
