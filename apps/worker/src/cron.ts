import { batchAudited } from "./lib/audit";
import { SUPPLY_SQL } from "./lib/db";
import { lotStub } from "./lib/lots";
import { setNoticeStatus } from "./ingest";

const STALE_NOTICE_MS = 30 * 60_000;

/** Every 15 min: finalise reservations whose alarm was missed, fail notices whose workflow died. */
export async function sweep(env: Env, now = Date.now()) {
  const { results: due } = await env.DB.prepare(`SELECT id FROM lots WHERE status = 'reserved' AND finalizes_at < ?`)
    .bind(now - 60_000)
    .all<{ id: string }>();
  let finalized = 0;
  for (const { id } of due) if (await lotStub(env, id).finalizeIfDue(now)) finalized++;

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

/** The network's lowest days of cover right now. Read-only: safe to call from any request path. */
export async function lowestCover(env: Env, now = Date.now()): Promise<CoverSnapshot> {
  const { results } = await env.DB.prepare(
    `SELECT s.site_id AS siteId, si.name AS siteName, s.drug_id AS drugId, d.name AS drugName, d.tier AS tier,
            ROUND(${SUPPLY_SQL} / s.daily_demand, 1) AS cover
       FROM stock s JOIN sites si ON si.id = s.site_id JOIN drugs d ON d.id = s.drug_id
      WHERE s.daily_demand > 0
      ORDER BY cover ASC, d.tier ASC LIMIT 15`,
  ).all<CoverSnapshot["lowest"][number]>();
  return { generatedAt: now, lowest: results };
}

/**
 * Nightly: UPSERT one cover row per (day, site, drug) and refresh the KV snapshot (1 KV write/day).
 * Running it twice leaves identical rows and, thanks to the per-day audit id, one audit entry.
 */
export async function rescoreCover(env: Env, now = Date.now()): Promise<CoverSnapshot> {
  const day = new Date(now).toISOString().slice(0, 10);
  const snapshot = await lowestCover(env, now);
  await batchAudited(
    env,
    [
      env.DB.prepare(
        `INSERT INTO cover_history (day, site_id, drug_id, cover)
         SELECT ?, s.site_id, s.drug_id, ROUND(${SUPPLY_SQL} / s.daily_demand, 1)
           FROM stock s WHERE s.daily_demand > 0
         ON CONFLICT (day, site_id, drug_id) DO UPDATE SET cover = excluded.cover`,
      ).bind(day),
    ],
    [{ id: `cron:cover:${day}`, entity: "system", entityId: "cron", action: "cover.rescored", actor: "cron", payload: { day, lowest: snapshot.lowest.length } }],
  );
  await env.CACHE.put("cover:snapshot", JSON.stringify(snapshot));
  return snapshot;
}
