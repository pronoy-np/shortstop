import { computeSplit, type SplitResult } from "@shortstop/shared";
import { loadSiteStock } from "./db";

export const lotStub = (env: Env, lotId: string) => env.LOT_DO.get(env.LOT_DO.idFromName(lotId));

export const autopilotActor = (ruleId: string | null, policyVersion: number) => `autopilot:${ruleId ?? "default"}@v${policyVersion}`;

/** Fresh split of whatever is still available for a lot's drug. */
export async function splitAvailable(env: Env, drugId: string, available: number): Promise<SplitResult> {
  return computeSplit(Math.max(0, available), await loadSiteStock(env, drugId));
}

/**
 * The one place that decides a lot's D1 status. Inputs come from the LotDO ledger
 * (never from a request), so inlining them as integers is safe.
 */
export function lotStatusSql(reserved: boolean, available: number): string {
  return `CASE WHEN ${reserved ? 1 : 0} = 1 THEN 'reserved' WHEN ${Math.trunc(available)} = 0 THEN 'committed'
    WHEN substitute_status = 'pending' THEN 'needs_pharmacist' ELSE 'open' END`;
}
