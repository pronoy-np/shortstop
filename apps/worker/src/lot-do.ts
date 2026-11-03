import type { Allocation } from "@shortstop/shared";
import { DurableObject } from "cloudflare:workers";

export type CommitResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "insufficient"; remaining: number };

// One per lot. The only writer of the lot's remaining quantity; the ledger never goes negative.
export class LotDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lot (id INTEGER PRIMARY KEY CHECK (id = 1), quantity INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger (idem_key TEXT PRIMARY KEY, site_id TEXT NOT NULL, quantity INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
      `);
    });
  }

  // TODO(week 2): init(quantity), commit(allocations, idemKey), reserveAuto(...), cancel, takeOver, alarm().
  async commit(_allocations: Allocation[], _idemKey: string): Promise<CommitResult> {
    throw new Error("LotDO.commit not implemented");
  }
}
