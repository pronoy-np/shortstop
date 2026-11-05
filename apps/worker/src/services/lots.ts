import { CommitRequest, ReservationMode, SubstituteDecision, sumQuantity, type Allocation, type Role, type SplitResult } from "@shortstop/shared";
import { z } from "zod";
import { audit, batchAudited } from "../lib/audit";
import type { User } from "../lib/auth";
import { broadcast } from "../lib/board";
import { STATUS_AFTER_SUBSTITUTE_REVIEW_SQL, lotStub, splitAvailable } from "../lib/lots";
import { fail, forbidUnless, invalid, invalidField, isRecord, type Result } from "./result";

export const COMMIT_ROLES: readonly Role[] = ["planner", "ops_lead"];
export const SUBSTITUTE_ROLES: readonly Role[] = ["pharmacist"];

// Lot ids are `<notice id>-<n>`; anything else is not a lot (and must not become a Durable Object name).
export const LotId = z.string().regex(/^n_[a-z0-9]{1,32}-\d{1,4}$/);
const IdempotencyKey = z.string().min(8).max(100);
// key is optional: without one, LotDO derives it from the reservation, so retries are replays either way.
const ReservationAction = z.object({ mode: ReservationMode, key: z.string().min(8).max(100).optional() });
const SubstituteBody = z.object({ decision: SubstituteDecision, note: z.string().max(500).optional() });

const lotNotFound = () => fail("not_found", "lot not found");

/** Splits the transport-neutral input into the lot id and the rest (the body the schema validates). */
function split(input: unknown): { lotId: string | null; rest: Record<string, unknown> } {
  const { lotId, ...rest } = isRecord(input) ? input : {};
  const id = LotId.safeParse(lotId);
  return { lotId: id.success ? id.data : null, rest };
}

export type CommitInput = { lotId: string; idempotencyKey?: string; commitKey?: string; allocations: Allocation[] };
export type CommitOk = { available: number; replay: boolean };
export type CommitExtra = { available?: number; proposal?: SplitResult };

/**
 * A human commit. `idempotencyKey` (the HTTP header) wins over `commitKey` (the body or form field). A replay writes
 * nothing and reports current availability; the same key reused for a different commit is `key_conflict`. Losing the
 * race is `conflict` with the rebased proposal for what is left.
 */
export async function commitLot(env: Env, actor: User, input: unknown): Promise<Result<CommitOk, CommitExtra>> {
  const { lotId, rest } = split(input);
  if (!lotId) return lotNotFound();
  const denied = forbidUnless(actor, COMMIT_ROLES);
  if (denied) return denied;
  const parsed = CommitRequest.safeParse(rest);
  if (!parsed.success) return invalid(parsed.error, parsed.error.issues[0]?.message ?? "invalid body");
  const key = IdempotencyKey.safeParse(rest.idempotencyKey ?? parsed.data.commitKey);
  if (!key.success) return invalidField("commitKey", "send an Idempotency-Key header (8-100 chars) or a commitKey");
  // "auto:" keys belong to autopilot reservations; a human key in that namespace would collide on finalize.
  if (key.data.startsWith("auto:")) return invalidField("commitKey", "commit keys may not start with auto:");

  const lot = await env.DB.prepare(`SELECT drug_id, substitute_status FROM lots WHERE id = ?`)
    .bind(lotId)
    .first<{ drug_id: string; substitute_status: string | null }>();
  if (!lot) return lotNotFound();
  // Hard floor: a suggested substitute must be reviewed by a pharmacist before anything ships.
  if (lot.substitute_status === "pending") return fail("conflict", "pharmacist review of the substitute is required first");

  const { results: siteRows } = await env.DB.prepare(`SELECT id FROM sites`).all<{ id: string }>();
  const known = new Set(siteRows.map((s) => s.id));
  const allocations = parsed.data.allocations.filter((a) => a.quantity > 0);
  if (allocations.some((a) => !known.has(a.siteId))) return invalidField("allocations", "unknown site");
  if (new Set(allocations.map((a) => a.siteId)).size !== allocations.length) return invalidField("allocations", "duplicate site");
  if (allocations.length === 0) return invalidField("allocations", "nothing to commit");

  const result = await lotStub(env, lotId).commit(key.data, allocations, actor.email);
  if (result.ok) return result;
  if (result.reason === "key_conflict")
    return fail("key_conflict", "this Idempotency-Key was already used for a different commit; send a new key", { available: result.available });

  // Not a state change, but worth tracing: who tried to take stock that wasn't there.
  await audit(env, {
    id: `lot:${lotId}:rejected:${key.data}`,
    entity: "lot",
    entityId: lotId,
    action: "lot.commit_rejected",
    actor: actor.email,
    outcome: "rejected",
    payload: { reason: result.reason, available: result.available, requested: sumQuantity(allocations) },
  });

  // Lost the race (or a reservation holds stock): hand back a fresh split of what is actually left,
  // and tell every open board so stale editors rebase too.
  const rebased = await splitAvailable(env, lot.drug_id, result.available);
  await broadcast(env, { type: "lot.rebased", lotId, remaining: result.available, actor: actor.email });
  return fail("conflict", result.reason, { available: result.available, proposal: rebased });
}

export type ReservationOk = { available: number; allocations: Allocation[]; replay: boolean };

/** Cancel or take over a pending auto-commit. Input: `{ lotId, mode, key? }`; the key is server-derived when absent. */
export async function cancelReservation(env: Env, actor: User, input: unknown): Promise<Result<ReservationOk, { available?: number }>> {
  const { lotId, rest } = split(input);
  if (!lotId) return lotNotFound();
  const denied = forbidUnless(actor, COMMIT_ROLES);
  if (denied) return denied;
  const body = ReservationAction.safeParse(rest);
  if (!body.success) return invalid(body.error, "body must be { mode: cancel | takeover, key? }");
  const r = await lotStub(env, lotId).cancelReservation(actor.email, body.data.mode, body.data.key);
  return r.ok ? r : fail("conflict", "no pending auto-commit on this lot", { available: r.available });
}

/** Pharmacist review of a suggested substitute. Input: `{ lotId, decision, note? }`. */
export async function reviewSubstitute(env: Env, actor: User, input: unknown): Promise<Result<{}>> {
  const { lotId, rest } = split(input);
  if (!lotId) return lotNotFound();
  // Hard floor: only a pharmacist decides on a substitute.
  const denied = forbidUnless(actor, SUBSTITUTE_ROLES);
  if (denied) return denied;
  const body = SubstituteBody.safeParse(rest);
  if (!body.success) return invalid(body.error, "decision must be approved or rejected");
  // One transaction: the audit row is only written if this request's UPDATE is what made the decision.
  const res = await batchAudited(
    env,
    [
      env.DB.prepare(
        `UPDATE lots SET substitute_status = ?, status = ${STATUS_AFTER_SUBSTITUTE_REVIEW_SQL}
          WHERE id = ? AND substitute_status = 'pending'`,
      ).bind(body.data.decision, lotId),
    ],
    [
      {
        id: `lot:${lotId}:substitute`,
        entity: "lot",
        entityId: lotId,
        action: `lot.substitute_${body.data.decision}`,
        actor: actor.email,
        payload: body.data,
        onlyIf: { sql: `SELECT 1 FROM lots WHERE id = ? AND substitute_status = ?`, binds: [lotId, body.data.decision] },
      },
    ],
  );
  if (!res[0]?.meta.changes) return fail("conflict", "no pending substitute on this lot");
  await broadcast(env, { type: "lot.substitute", lotId, status: body.data.decision });
  return { ok: true };
}

/** Fresh split of whatever is still available (after partial commits or a cancelled reservation). */
export async function loadProposal(env: Env, lotId: unknown): Promise<Result<{ available: number; proposal: SplitResult }>> {
  const id = LotId.safeParse(lotId);
  if (!id.success) return lotNotFound();
  const lot = await env.DB.prepare(`SELECT drug_id FROM lots WHERE id = ?`).bind(id.data).first<{ drug_id: string }>();
  if (!lot) return lotNotFound();
  const state = await lotStub(env, id.data).state();
  return { ok: true, available: state.available, proposal: await splitAvailable(env, lot.drug_id, state.available) };
}

/** R2 keys of the confirmation documents stored for a lot. */
export async function listConfirmations(env: Env, lotId: unknown): Promise<Result<{ keys: string[] }>> {
  const id = LotId.safeParse(lotId);
  if (!id.success) return lotNotFound();
  const list = await env.FILES.list({ prefix: `confirmations/${id.data}/` });
  return { ok: true, keys: list.objects.map((o) => o.key) };
}
