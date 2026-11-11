import { computeSplit, type SiteBase, type SiteStock, type SplitResult } from "@shortstop/shared";
import { loadSiteStock } from "./db";

export const lotStub = (env: Env, lotId: string) => env.LOT_DO.get(env.LOT_DO.idFromName(lotId));

export const autopilotActor = (ruleId: string | null, policyVersion: number) => `autopilot:${ruleId ?? "default"}@v${policyVersion}`;

export type SplitWithBase = SplitResult & { base: Record<string, SiteBase> };

/** A split plus each site's supply and demand before it, so an editor can recompute cover for any quantity typed. */
export function splitWithBase(quantity: number, sites: SiteStock[]): SplitWithBase {
  const base = Object.fromEntries(sites.filter((s) => s.dailyDemand > 0).map((s) => [s.siteId, { onHand: s.onHand, inbound: s.inbound, dailyDemand: s.dailyDemand }]));
  return { ...computeSplit(quantity, sites), base };
}

/** Fresh split of whatever is still available for a lot's drug. */
export async function splitAvailable(env: Env, drugId: string, available: number): Promise<SplitWithBase> {
  return splitWithBase(Math.max(0, available), await loadSiteStock(env, drugId));
}

/**
 * All lot-status rules live in this module. This one derives D1 status from the LotDO ledger. Inputs come from the ledger
 * (never from a request), so inlining them as integers is safe.
 */
export function lotStatusSql(reserved: boolean, available: number): string {
  return `CASE WHEN ${reserved ? 1 : 0} = 1 THEN 'reserved' WHEN ${Math.trunc(available)} = 0 THEN 'committed'
    WHEN substitute_status = 'pending' THEN 'needs_pharmacist' ELSE 'open' END`;
}

/** A new lot waits for a pharmacist when a substitute was suggested, otherwise for a planner. */
export const initialLotStatus = (needsSubstitute: boolean) => (needsSubstitute ? "needs_pharmacist" : "open") as "needs_pharmacist" | "open";

/** After a pharmacist reviews the substitute, a lot that was waiting on them is ready for planners. */
export const STATUS_AFTER_SUBSTITUTE_REVIEW_SQL = `CASE WHEN status = 'needs_pharmacist' THEN 'open' ELSE status END`;
