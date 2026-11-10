import { csvCell } from "@shortstop/shared";
import type { CoverSnapshot } from "../cron";
import { lowestCover } from "../cron";
import { audit } from "../lib/audit";
import type { User } from "../lib/auth";

export type MetricsView = {
  notices: { status: string; n: number }[];
  lots: { status: string; n: number }[];
  units: { kind: "auto" | "manual"; units: number; lots: number }[];
  overrides: { action: string; n: number }[];
  avgMinutesToFirstCommit: number;
  deadLetters: number;
  /** Units committed per UTC day and kind, for the last `DAILY_DAYS` days (days with nothing committed are absent). */
  daily: { day: string; kind: "auto" | "manual"; units: number }[];
  cover: CoverSnapshot;
};

export const DAILY_DAYS = 14;
const DAY_MS = 86_400_000;

export async function loadMetrics(env: Env, now = Date.now()): Promise<MetricsView> {
  const since = Math.floor(now / DAY_MS) * DAY_MS - (DAILY_DAYS - 1) * DAY_MS;
  const [notices, lots, units, cancels, timing, dead, daily] = await env.DB.batch([
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM notices GROUP BY status`),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM lots GROUP BY status`),
    env.DB.prepare(`SELECT kind, SUM(quantity) AS units, COUNT(DISTINCT lot_id) AS lots FROM allocations GROUP BY kind`),
    env.DB.prepare(`SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN ('lot.reservation_cancelled', 'lot.taken_over') GROUP BY action`),
    env.DB.prepare(
      `SELECT AVG(first_at - created_at) AS avgMs FROM (SELECT l.created_at, MIN(a.at) AS first_at FROM lots l JOIN allocations a ON a.lot_id = l.id GROUP BY l.id)`,
    ),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters`),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, kind, SUM(quantity) AS units
         FROM allocations WHERE at >= ? GROUP BY day, kind ORDER BY day`,
    ).bind(since),
  ]);
  // Read path: use the nightly snapshot, or compute it live without writing anything.
  const cover = (await env.CACHE.get<CoverSnapshot>("cover:snapshot", "json")) ?? (await lowestCover(env));
  return {
    notices: notices!.results as MetricsView["notices"],
    lots: lots!.results as MetricsView["lots"],
    units: units!.results as MetricsView["units"],
    overrides: cancels!.results as MetricsView["overrides"],
    avgMinutesToFirstCommit: ((timing!.results[0] as { avgMs: number | null })?.avgMs ?? 0) / 60_000,
    deadLetters: (dead!.results[0] as { n: number }).n,
    daily: daily!.results as MetricsView["daily"],
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
