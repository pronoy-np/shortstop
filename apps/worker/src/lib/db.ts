import * as schema from "@shortstop/db";
import type { SiteStock } from "@shortstop/shared";
import { drizzle } from "drizzle-orm/d1";

export { schema };
export const db = (env: Env) => drizzle(env.DB, { schema });
export type DB = ReturnType<typeof db>;

export const newId = () => crypto.randomUUID();

/**
 * Site stock for one drug. inbound = baseline inbound + everything already allocated to the site
 * for this drug, so a fresh split always accounts for earlier commits.
 */
export async function loadSiteStock(env: Env, drugId: string): Promise<SiteStock[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.site_id AS siteId, si.name AS siteName, si.acuity AS acuity, s.on_hand AS onHand,
            s.inbound + COALESCE((SELECT SUM(a.quantity) FROM allocations a JOIN lots l ON l.id = a.lot_id
                                  WHERE a.site_id = s.site_id AND l.drug_id = s.drug_id), 0) AS inbound,
            s.daily_demand AS dailyDemand
       FROM stock s JOIN sites si ON si.id = s.site_id
      WHERE s.drug_id = ?`,
  )
    .bind(drugId)
    .all<SiteStock>();
  return results;
}
