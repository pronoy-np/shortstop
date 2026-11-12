import type { Role } from "@shortstop/shared";
import { rescoreCover } from "../cron";
import { batchAudited } from "../lib/audit";
import type { User } from "../lib/auth";
import { broadcast } from "../lib/board";
import { SUPPLY_SQL } from "../lib/db";
import { forbidUnless, type Result } from "./result";

export const STOCK_RESET_ROLES: readonly Role[] = ["ops_lead"];

/**
 * Brings the network back to its baseline scarcity (ops lead). Nothing in the desk draws stock down, so every committed
 * allocation keeps counting toward a site's supply and cover only ever climbs. This treats everything allocated so far
 * as delivered and used: `stock.inbound` becomes minus the site's allocated units, so supply (`SUPPLY_SQL`) is `on_hand`
 * again and later allocations count from there. Lots, allocations, the LotDO ledgers and the audit trail are untouched.
 * Running it twice changes nothing the second time. `units` is how much supply the reset took out.
 */
export async function resetScarcity(env: Env, actor: User, _input?: unknown): Promise<Result<{ units: number }>> {
  const denied = forbidUnless(actor, STOCK_RESET_ROLES);
  if (denied) return denied;
  const before = await env.DB.prepare(`SELECT COALESCE(SUM(${SUPPLY_SQL} - s.on_hand), 0) AS units FROM stock s`).first<{ units: number }>();
  const units = before?.units ?? 0;
  await batchAudited(
    env,
    [
      env.DB.prepare(
        `UPDATE stock SET inbound = -COALESCE((SELECT SUM(a.quantity) FROM allocations a JOIN lots l ON l.id = a.lot_id
           WHERE a.site_id = stock.site_id AND l.drug_id = stock.drug_id), 0)`,
      ),
    ],
    [{ entity: "system", entityId: "stock", action: "stock.scarcity_reset", actor: actor.email, payload: { units } }],
  );
  // The metrics page reads the cover snapshot from KV: refresh it now rather than at the nightly run (1 KV write).
  try {
    await rescoreCover(env);
  } catch (err) {
    console.warn("cover rescore after stock reset failed", err);
  }
  await broadcast(env, { type: "stock.reset", actor: actor.email });
  return { ok: true, units };
}
