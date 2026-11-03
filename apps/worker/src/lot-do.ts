import type { Allocation } from "@shortstop/shared";
import { DurableObject } from "cloudflare:workers";
import { auditStmt } from "./lib/audit";
import { broadcast } from "./lib/board";
import { writeConfirmation } from "./lib/confirmation";

export type LotState = {
  lotId: string;
  quantity: number;
  committed: number;
  reserved: number;
  available: number;
  reservation: { commitKey: string; finalizesAt: number; ruleId: string | null; policyVersion: number; allocations: Allocation[] } | null;
};

export type CommitResult =
  | { ok: true; available: number; replay: boolean }
  | { ok: false; reason: "insufficient" | "reserved" | "not_initialised"; available: number };

type LedgerEntry = { commitKey: string; kind: "manual" | "auto"; actor: string; allocations: Allocation[]; at: number };

const sum = (a: Allocation[]) => a.reduce((s, x) => s + x.quantity, 0);

/**
 * One per lot, and the only writer of how much of the lot is left.
 * Every check-and-write below runs synchronously against DO SQLite before the first await,
 * so two concurrent commits can never both pass the availability check.
 * D1 is a mirror for querying; every mirror write is idempotent so retries are safe.
 */
export class LotDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lot (id INTEGER PRIMARY KEY CHECK (id = 1), lot_id TEXT NOT NULL, quantity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (commit_key TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL,
        allocations_json TEXT NOT NULL, total INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservation (id INTEGER PRIMARY KEY CHECK (id = 1), commit_key TEXT NOT NULL,
        allocations_json TEXT NOT NULL, total INTEGER NOT NULL, rule_id TEXT, policy_version INTEGER NOT NULL, finalizes_at INTEGER NOT NULL);
    `);
  }

  init(lotId: string, quantity: number): LotState {
    this.sql.exec(`INSERT OR IGNORE INTO lot (id, lot_id, quantity) VALUES (1, ?, ?)`, lotId, quantity);
    return this.state();
  }

  state(): LotState {
    const lot = this.sql.exec<{ lot_id: string; quantity: number }>(`SELECT lot_id, quantity FROM lot`).toArray()[0];
    const committed = this.sql.exec<{ t: number }>(`SELECT COALESCE(SUM(total), 0) AS t FROM ledger`).one().t;
    const r = this.sql
      .exec<{ commit_key: string; allocations_json: string; total: number; rule_id: string | null; policy_version: number; finalizes_at: number }>(
        `SELECT * FROM reservation`,
      )
      .toArray()[0];
    const quantity = lot?.quantity ?? 0;
    const reserved = r?.total ?? 0;
    return {
      lotId: lot?.lot_id ?? "",
      quantity,
      committed,
      reserved,
      available: quantity - committed - reserved,
      reservation: r
        ? {
            commitKey: r.commit_key,
            finalizesAt: r.finalizes_at,
            ruleId: r.rule_id,
            policyVersion: r.policy_version,
            allocations: JSON.parse(r.allocations_json),
          }
        : null,
    };
  }

  /** Human commit. Same commitKey twice is a replay and returns the original outcome. */
  async commit(commitKey: string, allocations: Allocation[], actor: string): Promise<CommitResult> {
    const before = this.state();
    if (!before.lotId) return { ok: false, reason: "not_initialised", available: 0 };
    const existing = this.ledgerEntry(commitKey);
    if (existing) {
      await this.mirror(existing);
      return { ok: true, available: this.state().available, replay: true };
    }
    if (sum(allocations) > before.available) return { ok: false, reason: "insufficient", available: before.available };

    const entry: LedgerEntry = { commitKey, kind: "manual", actor, allocations, at: Date.now() };
    this.insertLedger(entry);
    await this.mirror(entry);
    return { ok: true, available: this.state().available, replay: false };
  }

  /** Autopilot hold: counts against the lot immediately, finalises when the alarm fires. */
  async reserveAuto(args: {
    commitKey: string;
    allocations: Allocation[];
    ruleId: string | null;
    policyVersion: number;
    windowMs: number;
  }): Promise<CommitResult> {
    const before = this.state();
    if (!before.lotId) return { ok: false, reason: "not_initialised", available: 0 };
    if (before.reservation?.commitKey === args.commitKey || this.ledgerEntry(args.commitKey))
      return { ok: true, available: before.available, replay: true };
    if (before.reservation) return { ok: false, reason: "reserved", available: before.available };
    if (sum(args.allocations) > before.available) return { ok: false, reason: "insufficient", available: before.available };

    const finalizesAt = Date.now() + args.windowMs;
    this.sql.exec(
      `INSERT INTO reservation (id, commit_key, allocations_json, total, rule_id, policy_version, finalizes_at) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      args.commitKey,
      JSON.stringify(args.allocations),
      sum(args.allocations),
      args.ruleId,
      args.policyVersion,
      finalizesAt,
    );
    await this.ctx.storage.setAlarm(finalizesAt);
    const s = this.state();
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE lots SET status = 'reserved', remaining = ?, finalizes_at = ? WHERE id = ?`).bind(
        s.available,
        finalizesAt,
        s.lotId,
      ),
      auditStmt(this.env, {
        id: `lot:${s.lotId}:reserve:${args.commitKey}`,
        entity: "lot",
        entityId: s.lotId,
        action: "lot.reserved",
        actor: `autopilot:${args.ruleId ?? "default"}@v${args.policyVersion}`,
        payload: { allocations: args.allocations, finalizesAt, ruleId: args.ruleId, policyVersion: args.policyVersion },
      }),
    ]);
    await broadcast(this.env, { type: "lot.reserved", lotId: s.lotId, finalizesAt });
    return { ok: true, available: s.available, replay: false };
  }

  /** Planner cancels the pending auto-commit, or takes it over to edit and commit by hand. */
  async cancelReservation(actor: string, mode: "cancel" | "takeover"): Promise<{ ok: boolean; available: number }> {
    const before = this.state();
    if (!before.reservation) return { ok: false, available: before.available };
    this.sql.exec(`DELETE FROM reservation`);
    await this.ctx.storage.deleteAlarm();
    const s = this.state();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE lots SET remaining = ?, finalizes_at = NULL,
           status = CASE WHEN substitute_status = 'pending' THEN 'needs_pharmacist' ELSE 'open' END WHERE id = ?`,
      ).bind(s.available, s.lotId),
      auditStmt(this.env, {
        entity: "lot",
        entityId: s.lotId,
        action: mode === "cancel" ? "lot.reservation_cancelled" : "lot.taken_over",
        actor,
        payload: { reservation: before.reservation },
      }),
    ]);
    await broadcast(this.env, { type: "lot.cancelled", lotId: s.lotId, actor });
    return { ok: true, available: s.available };
  }

  async alarm(): Promise<void> {
    await this.finalizeIfDue();
  }

  /** Called by the alarm, and by the cron sweep as a backstop. */
  async finalizeIfDue(now = Date.now()): Promise<boolean> {
    const s = this.state();
    const r = s.reservation;
    if (!r) return false;
    if (r.finalizesAt > now) {
      await this.ctx.storage.setAlarm(r.finalizesAt);
      return false;
    }
    const entry: LedgerEntry = {
      commitKey: r.commitKey,
      kind: "auto",
      actor: `autopilot:${r.ruleId ?? "default"}@v${r.policyVersion}`,
      allocations: r.allocations,
      at: now,
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM reservation`);
      this.insertLedger(entry);
    });
    await this.mirror(entry);
    return true;
  }

  private ledgerEntry(commitKey: string): LedgerEntry | null {
    const row = this.sql
      .exec<{ commit_key: string; kind: "manual" | "auto"; actor: string; allocations_json: string; at: number }>(
        `SELECT commit_key, kind, actor, allocations_json, at FROM ledger WHERE commit_key = ?`,
        commitKey,
      )
      .toArray()[0];
    return row
      ? { commitKey: row.commit_key, kind: row.kind, actor: row.actor, allocations: JSON.parse(row.allocations_json), at: row.at }
      : null;
  }

  private insertLedger(e: LedgerEntry) {
    this.sql.exec(
      `INSERT INTO ledger (commit_key, kind, actor, allocations_json, total, at) VALUES (?, ?, ?, ?, ?, ?)`,
      e.commitKey,
      e.kind,
      e.actor,
      JSON.stringify(e.allocations),
      sum(e.allocations),
      e.at,
    );
  }

  /** Idempotent projection of a ledger entry into D1 + R2 + the live board. */
  private async mirror(e: LedgerEntry) {
    const s = this.state();
    const reserved = s.reservation !== null;
    const db = this.env.DB;
    await db.batch([
      ...e.allocations
        .filter((a) => a.quantity > 0)
        .map((a) =>
          db
            .prepare(
              `INSERT OR IGNORE INTO allocations (id, lot_id, site_id, quantity, kind, actor, commit_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(`${e.commitKey}:${a.siteId}`, s.lotId, a.siteId, a.quantity, e.kind, e.actor, e.commitKey, e.at),
        ),
      db
        .prepare(
          `UPDATE lots SET remaining = ?, finalizes_at = CASE WHEN ? THEN finalizes_at ELSE NULL END,
             status = CASE WHEN ? THEN 'reserved' WHEN ? = 0 THEN 'committed'
                           WHEN substitute_status = 'pending' THEN 'needs_pharmacist' ELSE 'open' END
           WHERE id = ?`,
        )
        .bind(s.available, reserved ? 1 : 0, reserved ? 1 : 0, s.available, s.lotId),
      auditStmt(this.env, {
        id: `lot:${s.lotId}:commit:${e.commitKey}`,
        entity: "lot",
        entityId: s.lotId,
        action: e.kind === "auto" ? "lot.auto_committed" : "lot.committed",
        actor: e.actor,
        payload: { commitKey: e.commitKey, allocations: e.allocations, available: s.available },
      }),
    ]);
    await writeConfirmation(this.env, { lotId: s.lotId, commitKey: e.commitKey, actor: e.actor, kind: e.kind, allocations: e.allocations });
    await broadcast(this.env, { type: "lot.committed", lotId: s.lotId, remaining: s.available, actor: e.actor });
  }
}
