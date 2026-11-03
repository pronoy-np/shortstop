import type { Allocation } from "@shortstop/shared";
import { DurableObject } from "cloudflare:workers";
import { batchAudited, type AuditEntry } from "./lib/audit";
import { broadcast } from "./lib/board";
import { writeConfirmation } from "./lib/confirmation";
import { autopilotActor, lotStatusSql } from "./lib/lots";

type Reservation = { commitKey: string; finalizesAt: number; ruleId: string | null; policyVersion: number; allocations: Allocation[] };

export type LotState = {
  lotId: string;
  quantity: number;
  committed: number;
  reserved: number;
  available: number;
  reservation: Reservation | null;
  version: number;
  pendingProjections: number;
};

export type CommitResult =
  | { ok: true; available: number; replay: boolean }
  | { ok: false; reason: "insufficient" | "reserved" | "not_initialised"; available: number };

export type CancelResult = { ok: true; available: number; allocations: Allocation[]; replay: boolean } | { ok: false; available: number };

type LedgerEntry = { commitKey: string; kind: "manual" | "auto"; actor: string; allocations: Allocation[]; at: number };

/** The lot as the ledger saw it right after a mutation: what D1 should show at that version. */
type Snapshot = { available: number; reserved: boolean; finalizesAt: number | null };

type Projection =
  | { kind: "committed"; entry: LedgerEntry; snapshot: Snapshot }
  | { kind: "reserved"; reservation: Reservation; snapshot: Snapshot }
  | { kind: "cancelled"; key: string; actor: string; mode: "cancel" | "takeover"; reservation: Reservation; snapshot: Snapshot };

const RETRY_MS = 30_000;
const sum = (a: Allocation[]) => a.reduce((s, x) => s + x.quantity, 0);

/**
 * One per lot, and the only writer of how much of the lot is left.
 *
 * Every mutation is a synchronous block against DO SQLite (no await inside), so two concurrent
 * commits can never both pass the availability check. The same block bumps the ledger version and
 * appends a projection to an outbox (transactional outbox). `flush()` then projects the outbox into
 * D1 / R2 / the live board in version order. D1 writes are guarded by `state_version`, so a slow or
 * retried projection can never move D1 backwards, and a failed projection is retried by the alarm
 * and the cron sweep instead of being lost.
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
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (version INTEGER PRIMARY KEY, projection_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cancels (cancel_key TEXT PRIMARY KEY, result_json TEXT NOT NULL);
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
        ? { commitKey: r.commit_key, finalizesAt: r.finalizes_at, ruleId: r.rule_id, policyVersion: r.policy_version, allocations: JSON.parse(r.allocations_json) }
        : null,
      version: this.sql.exec<{ v: number }>(`SELECT COALESCE(MAX(version), 0) AS v FROM meta`).one().v,
      pendingProjections: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`).one().n,
    };
  }

  /** Human commit. The same commitKey twice is a replay and returns the original outcome. */
  async commit(commitKey: string, allocations: Allocation[], actor: string): Promise<CommitResult> {
    const before = this.state();
    if (!before.lotId) return { ok: false, reason: "not_initialised", available: 0 };
    if (this.ledgerHas(commitKey)) {
      await this.flushSafely();
      return { ok: true, available: this.state().available, replay: true };
    }
    if (sum(allocations) > before.available) return { ok: false, reason: "insufficient", available: before.available };

    this.recordCommit({ commitKey, kind: "manual", actor, allocations, at: Date.now() });
    const available = this.state().available;
    await this.flushSafely();
    return { ok: true, available, replay: false };
  }

  /** Autopilot hold: counts against the lot immediately, finalises when the alarm fires. */
  async reserveAuto(args: { commitKey: string; allocations: Allocation[]; ruleId: string | null; policyVersion: number; windowMs: number }): Promise<CommitResult> {
    const before = this.state();
    if (!before.lotId) return { ok: false, reason: "not_initialised", available: 0 };
    if (before.reservation?.commitKey === args.commitKey || this.ledgerHas(args.commitKey)) {
      await this.flushSafely();
      return { ok: true, available: before.available, replay: true };
    }
    if (before.reservation) return { ok: false, reason: "reserved", available: before.available };
    if (sum(args.allocations) > before.available) return { ok: false, reason: "insufficient", available: before.available };

    const reservation: Reservation = {
      commitKey: args.commitKey,
      allocations: args.allocations,
      ruleId: args.ruleId,
      policyVersion: args.policyVersion,
      finalizesAt: Date.now() + args.windowMs,
    };
    this.sql.exec(
      `INSERT INTO reservation (id, commit_key, allocations_json, total, rule_id, policy_version, finalizes_at) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      reservation.commitKey,
      JSON.stringify(reservation.allocations),
      sum(reservation.allocations),
      reservation.ruleId,
      reservation.policyVersion,
      reservation.finalizesAt,
    );
    this.enqueue({ kind: "reserved", reservation, snapshot: this.snapshot() });
    const available = this.state().available;
    await this.flushSafely();
    return { ok: true, available, replay: false };
  }

  /**
   * Planner cancels the pending auto-commit, or takes it over. Take-over hands back the reserved
   * split so the planner can edit and commit it. Keyed, so a retried call is a replay.
   */
  async cancelReservation(actor: string, mode: "cancel" | "takeover", cancelKey: string): Promise<CancelResult> {
    const done = this.sql.exec<{ result_json: string }>(`SELECT result_json FROM cancels WHERE cancel_key = ?`, cancelKey).toArray()[0];
    if (done) {
      await this.flushSafely();
      return { ...(JSON.parse(done.result_json) as Extract<CancelResult, { ok: true }>), replay: true };
    }
    const before = this.state();
    if (!before.reservation) return { ok: false, available: before.available };

    const reservation = before.reservation;
    this.sql.exec(`DELETE FROM reservation`);
    const result: CancelResult = { ok: true, available: this.state().available, allocations: reservation.allocations, replay: false };
    this.sql.exec(`INSERT INTO cancels (cancel_key, result_json) VALUES (?, ?)`, cancelKey, JSON.stringify(result));
    this.enqueue({ kind: "cancelled", key: cancelKey, actor, mode, reservation, snapshot: this.snapshot() });
    await this.flushSafely();
    return result;
  }

  async alarm(): Promise<void> {
    await this.flush(); // throws on failure: the runtime retries the alarm with backoff
    await this.finalizeIfDue();
  }

  /** Called by the alarm, and by the cron sweep as a backstop (which also re-drives stuck projections). */
  async finalizeIfDue(now = Date.now()): Promise<boolean> {
    const r = this.state().reservation;
    if (!r || r.finalizesAt > now) {
      await this.flushSafely();
      return false;
    }
    this.sql.exec(`DELETE FROM reservation`);
    this.recordCommit({
      commitKey: r.commitKey,
      kind: "auto",
      actor: autopilotActor(r.ruleId, r.policyVersion),
      allocations: r.allocations,
      at: now,
    });
    await this.flushSafely();
    return true;
  }

  // --- internals -------------------------------------------------------------------------

  private ledgerHas(commitKey: string): boolean {
    return this.sql.exec(`SELECT 1 FROM ledger WHERE commit_key = ?`, commitKey).toArray().length > 0;
  }

  private recordCommit(e: LedgerEntry) {
    this.sql.exec(
      `INSERT INTO ledger (commit_key, kind, actor, allocations_json, total, at) VALUES (?, ?, ?, ?, ?, ?)`,
      e.commitKey,
      e.kind,
      e.actor,
      JSON.stringify(e.allocations),
      sum(e.allocations),
      e.at,
    );
    this.enqueue({ kind: "committed", entry: e, snapshot: this.snapshot() });
  }

  private snapshot(): Snapshot {
    const s = this.state();
    return { available: s.available, reserved: s.reservation !== null, finalizesAt: s.reservation?.finalizesAt ?? null };
  }

  private enqueue(p: Projection) {
    const version = this.state().version + 1;
    this.sql.exec(`INSERT INTO meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version`, version);
    this.sql.exec(`INSERT INTO outbox (version, projection_json) VALUES (?, ?)`, version, JSON.stringify(p));
  }

  // Serialises flushes within this instance so concurrent callers don't project the same rows twice.
  private flushing: Promise<void> = Promise.resolve();

  /** Projects the outbox in version order. Throws on the first failure (the row stays for the retry). */
  private flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushNow());
    this.flushing = run.catch(() => undefined);
    return run;
  }

  private async flushNow(): Promise<void> {
    const rows = this.sql.exec<{ version: number; projection_json: string }>(`SELECT version, projection_json FROM outbox ORDER BY version`).toArray();
    for (const row of rows) {
      await this.project(row.version, JSON.parse(row.projection_json) as Projection);
      this.sql.exec(`DELETE FROM outbox WHERE version = ?`, row.version);
    }
    await this.scheduleAlarm();
  }

  /** The ledger is already correct; a failed projection must not fail the caller. Retry via alarm. */
  private async flushSafely(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      console.error("LotDO projection failed; retrying via alarm", err);
      await this.scheduleAlarm();
    }
  }

  private async scheduleAlarm() {
    const s = this.state();
    const due = [s.reservation?.finalizesAt, s.pendingProjections > 0 ? Date.now() + RETRY_MS : undefined].filter((x): x is number => x !== undefined);
    if (due.length) await this.ctx.storage.setAlarm(Math.min(...due));
    else await this.ctx.storage.deleteAlarm();
  }

  private async project(version: number, p: Projection) {
    const lotId = this.state().lotId;
    const { available, reserved, finalizesAt } = p.snapshot;
    const db = this.env.DB;
    const lotUpdate = db
      .prepare(
        `UPDATE lots SET remaining = ?, finalizes_at = ?, status = ${lotStatusSql(reserved, available)}, state_version = ?
          WHERE id = ? AND state_version < ?`,
      )
      .bind(available, finalizesAt, version, lotId, version);

    if (p.kind === "committed") {
      const e = p.entry;
      const allocationRows = e.allocations
        .filter((a) => a.quantity > 0)
        .map((a) =>
          db
            .prepare(`INSERT OR IGNORE INTO allocations (id, lot_id, site_id, quantity, kind, actor, commit_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(`${e.commitKey}:${a.siteId}`, lotId, a.siteId, a.quantity, e.kind, e.actor, e.commitKey, e.at),
        );
      await batchAudited(this.env, [...allocationRows, lotUpdate], [
        {
          id: `lot:${lotId}:commit:${e.commitKey}`,
          entity: "lot",
          entityId: lotId,
          action: e.kind === "auto" ? "lot.auto_committed" : "lot.committed",
          actor: e.actor,
          payload: { commitKey: e.commitKey, allocations: e.allocations, available },
        },
      ]);
      await writeConfirmation(this.env, { lotId, ...e });
      await broadcast(this.env, { type: "lot.committed", lotId, remaining: available, actor: e.actor });
      return;
    }

    const r = p.reservation;
    const entry: AuditEntry =
      p.kind === "reserved"
        ? {
            id: `lot:${lotId}:reserve:${r.commitKey}`,
            entity: "lot",
            entityId: lotId,
            action: "lot.reserved",
            actor: autopilotActor(r.ruleId, r.policyVersion),
            payload: { allocations: r.allocations, finalizesAt: r.finalizesAt, ruleId: r.ruleId, policyVersion: r.policyVersion },
          }
        : {
            id: `lot:${lotId}:cancel:${p.key}`,
            entity: "lot",
            entityId: lotId,
            action: p.mode === "cancel" ? "lot.reservation_cancelled" : "lot.taken_over",
            actor: p.actor,
            payload: { reservation: r },
          };
    await batchAudited(this.env, [lotUpdate], [entry]);
    await broadcast(
      this.env,
      p.kind === "reserved" ? { type: "lot.reserved", lotId, finalizesAt: r.finalizesAt } : { type: "lot.cancelled", lotId, actor: p.actor },
    );
  }
}
