import { csvCell } from "@shortstop/shared";
import type { CoverSnapshot } from "../cron";
import { lowestCover } from "../cron";
import { audit } from "../lib/audit";
import type { User } from "../lib/auth";

export type MetricsView = {
  notices: unknown[];
  lots: unknown[];
  units: unknown[];
  overrides: unknown[];
  avgMinutesToFirstCommit: number;
  deadLetters: number;
  cover: CoverSnapshot;
};

export async function loadMetrics(env: Env): Promise<MetricsView> {
  const [notices, lots, units, cancels, timing, dead] = await env.DB.batch([
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM notices GROUP BY status`),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM lots GROUP BY status`),
    env.DB.prepare(`SELECT kind, SUM(quantity) AS units, COUNT(DISTINCT lot_id) AS lots FROM allocations GROUP BY kind`),
    env.DB.prepare(`SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN ('lot.reservation_cancelled', 'lot.taken_over') GROUP BY action`),
    env.DB.prepare(
      `SELECT AVG(first_at - created_at) AS avgMs FROM (SELECT l.created_at, MIN(a.at) AS first_at FROM lots l JOIN allocations a ON a.lot_id = l.id GROUP BY l.id)`,
    ),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters`),
  ]);
  // Read path: use the nightly snapshot, or compute it live without writing anything.
  const cover = (await env.CACHE.get<CoverSnapshot>("cover:snapshot", "json")) ?? (await lowestCover(env));
  return {
    notices: notices!.results,
    lots: lots!.results,
    units: units!.results,
    overrides: cancels!.results,
    avgMinutesToFirstCommit: ((timing!.results[0] as { avgMs: number | null })?.avgMs ?? 0) / 60_000,
    deadLetters: (dead!.results[0] as { n: number }).n,
    cover,
  };
}

/** Every allocation as CSV (formula-neutralised cells). The export itself is audited. */
export async function exportAllocationsCsv(env: Env, actor: User): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT a.at, a.lot_id, d.name AS drug, si.name AS site, a.quantity, a.kind, a.actor
       FROM allocations a JOIN lots l ON l.id = a.lot_id JOIN drugs d ON d.id = l.drug_id JOIN sites si ON si.id = a.site_id
      ORDER BY a.at`,
  ).all<Record<string, string | number>>();
  const header = "committed_at,lot_id,drug,site,quantity,kind,actor";
  const lines = results.map((r) => [new Date(Number(r.at)).toISOString(), r.lot_id, r.drug, r.site, r.quantity, r.kind, r.actor].map((v) => csvCell(v!)).join(","));
  await audit(env, { entity: "system", entityId: "export", action: "allocations.exported", actor: actor.email, payload: { rows: results.length } });
  return [header, ...lines].join("\n");
}
