import {
  checkPolicy,
  computeSplit,
  planReroutes,
  PolicyRules,
  type LotRef,
  type PolicyAction,
  type PolicyMoved,
  type PolicyPreview,
  type PolicyRule,
  type Reroute,
  type RerouteCandidate,
  type Role,
  type SiteStock,
  type Tier,
} from "@shortstop/shared";
import { z } from "zod";
import { batchAudited } from "../lib/audit";
import type { User } from "../lib/auth";
import { broadcast } from "../lib/board";
import { loadSiteStock } from "../lib/db";
import { autopilotActor, lotStub } from "../lib/lots";
import { getPolicy, savePolicy, type CurrentPolicy } from "../lib/policy-store";
import { forbidUnless, invalid, invalidField, type Fail, type Result } from "./result";

export const POLICY_ROLES: readonly Role[] = ["ops_lead"];

const PolicyBody = z.object({ rules: PolicyRules });

export type PolicyVersionView = { version: number; createdBy: string; createdAt: number; rules: PolicyRule[] };
export type PolicyView = { current: CurrentPolicy; versions: PolicyVersionView[] };

/** The current policy (KV-cached) and the last 20 immutable versions. */
export async function loadPolicy(env: Env): Promise<PolicyView> {
  const current = await getPolicy(env);
  const { results: versions } = await env.DB.prepare(
    `SELECT version, created_by AS createdBy, created_at AS createdAt, rules_json AS rulesJson FROM policy_versions ORDER BY version DESC LIMIT 20`,
  ).all<Omit<PolicyVersionView, "rules"> & { rulesJson: string }>();
  return { current, versions: versions.map(({ rulesJson, ...v }) => ({ ...v, rules: JSON.parse(rulesJson) as PolicyRule[] })) };
}

/** Role, schema and `checkPolicy`: the same gate for saving and for previewing. */
function validRules(actor: User, input: unknown): Fail | { ok: true; rules: PolicyRule[] } {
  const denied = forbidUnless(actor, POLICY_ROLES);
  if (denied) return denied;
  const body = PolicyBody.safeParse(input);
  if (!body.success) return invalid(body.error, body.error.issues[0]?.message ?? "invalid rules");
  const issue = checkPolicy(body.data.rules)[0];
  if (issue) return invalidField("rules", `rule ${issue.rule + 1} (${body.data.rules[issue.rule]!.id}) ${issue.message}`);
  return { ok: true, rules: body.data.rules };
}

// --- re-apply ------------------------------------------------------------------------------------

type CandidateRow = {
  lotId: string;
  status: "open" | "reserved";
  action: PolicyAction;
  quantity: number;
  drugId: string;
  drugName: string;
  tier: Tier;
  drugClass: string;
  confidence: number;
  needsSubstitute: number;
  wholesaler: string | null;
  noticeRef: string | null;
  filename: string;
};

// Bounds one save's work (each move is a few Durable Object and D1 calls). The desk never has this many untouched lots.
const MAX_CANDIDATES = 300;

/**
 * Lots a policy save may move: nothing committed (no allocation rows), and either open with nothing taken from it or
 * holding an autopilot reservation. Lots waiting on a pharmacist, committed or partly committed lots never qualify. The
 * policy inputs are the lot's original quantity, its notice's confidence and its stored substitute, exactly as at ingest.
 */
async function loadCandidates(env: Env): Promise<CandidateRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.id AS lotId, l.status, l.action, l.quantity, l.drug_id AS drugId, d.name AS drugName, d.tier, d.drug_class AS drugClass,
            COALESCE(n.confidence, 0) AS confidence, (l.substitute_id IS NOT NULL) AS needsSubstitute,
            n.wholesaler, n.notice_ref AS noticeRef, n.filename
       FROM lots l JOIN drugs d ON d.id = l.drug_id JOIN notices n ON n.id = l.notice_id
      WHERE ((l.status = 'open' AND l.remaining = l.quantity) OR l.status = 'reserved')
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.lot_id = l.id)
      ORDER BY l.created_at, l.id LIMIT ${MAX_CANDIDATES}`,
  ).all<CandidateRow>();
  return results;
}

const asCandidate = (r: CandidateRow): RerouteCandidate => ({
  lotId: r.lotId,
  status: r.status,
  action: r.action,
  tier: r.tier,
  drugClass: r.drugClass,
  lotQty: r.quantity,
  confidence: r.confidence,
  needsSubstitute: r.needsSubstitute === 1,
});

/** The candidates and what the given rules would do to them: the one selection the preview and the save share. */
async function selectReroutes(env: Env, rules: PolicyRule[]): Promise<{ rows: Map<string, CandidateRow>; reroutes: Reroute[] }> {
  const rows = await loadCandidates(env);
  return { rows: new Map(rows.map((r) => [r.lotId, r])), reroutes: planReroutes(rules, rows.map(asCandidate)) };
}

const noticeLabel = (r: CandidateRow) => [r.wholesaler, r.noticeRef].filter(Boolean).join(" ") || r.filename;
const lotRef = (r: CandidateRow): LotRef => ({ lotId: r.lotId, drugName: r.drugName, noticeLabel: noticeLabel(r) });

/** The audit actor for a move: the autopilot rule that took the lot, or the policy version that handed it back. */
const rerouteActor = (r: Reroute, version: number) => (r.to === "autopilot" ? autopilotActor(r.decision.ruleId, version) : `policy:v${version}`);

/**
 * Re-runs the policy over lots already on the desk after a save. LotDO stays the only writer of quantities: a move to
 * autopilot is a fresh `reserveAuto` under a key versioned by policy (so it gets its own audit row and a re-run is a
 * replay), refused by the DO if anything was committed meanwhile; a move back to planners cancels the reservation under a
 * per-version key. Only when the DO accepted does the lot's routing (action, rule, version, floor, reroute marker) change
 * in D1, guarded by `rerouted_version` and audited under `lot:<id>:rerouted:v<version>`. Safe to run again for the same
 * version. One lot failing is logged and skipped: the save has already happened and the rest still move.
 */
export async function reapplyPolicy(env: Env, policy: CurrentPolicy): Promise<PolicyMoved> {
  const { rows, reroutes } = await selectReroutes(env, policy.rules);
  const windowMs = Number(env.AUTOPILOT_WINDOW_MINUTES) * 60_000;
  const stock = new Map<string, SiteStock[]>();
  const moved: PolicyMoved = { toAutopilot: 0, toPlanner: 0 };
  const v = policy.version;

  for (const r of reroutes) {
    const row = rows.get(r.lotId)!;
    try {
      const stub = lotStub(env, r.lotId);
      let accepted: boolean;
      if (r.to === "autopilot") {
        if (!stock.has(row.drugId)) stock.set(row.drugId, await loadSiteStock(env, row.drugId));
        const split = computeSplit(row.quantity, stock.get(row.drugId)!);
        if (split.allocations.length === 0) continue;
        await stub.init(r.lotId, row.quantity);
        const res = await stub.reserveAuto({
          commitKey: `auto:${r.lotId}:v${v}`,
          allocations: split.allocations,
          ruleId: r.decision.ruleId,
          policyVersion: v,
          windowMs,
          untouchedOnly: true,
        });
        accepted = res.ok;
      } else {
        const res = await stub.cancelReservation(`policy:v${v}`, "cancel", `policy:v${v}:${r.lotId}`);
        accepted = res.ok;
      }
      if (!accepted) continue;

      const now = Date.now();
      await batchAudited(
        env,
        [
          env.DB.prepare(
            `UPDATE lots SET action = ?, rule_id = ?, policy_version = ?, hard_floor = ?, rerouted_to = ?, rerouted_version = ?, rerouted_at = ?
              WHERE id = ? AND (rerouted_version IS NULL OR rerouted_version < ?)`,
          ).bind(r.decision.action, r.decision.ruleId, v, r.decision.hardFloor, r.to, v, now, r.lotId, v),
        ],
        [
          {
            id: `lot:${r.lotId}:rerouted:v${v}`,
            entity: "lot",
            entityId: r.lotId,
            action: r.to === "autopilot" ? "lot.rerouted_to_autopilot" : "lot.rerouted_to_planner",
            actor: rerouteActor(r, v),
            payload: { policyVersion: v, to: r.to, from: row.action, ...r.decision },
          },
        ],
      );
      if (r.to === "autopilot") moved.toAutopilot++;
      else moved.toPlanner++;
    } catch (err) {
      console.error(`policy v${v}: could not move lot ${r.lotId}`, err);
    }
  }
  if (moved.toAutopilot || moved.toPlanner) await broadcast(env, { type: "policy.reapplied", version: v, ...moved });
  return moved;
}

/**
 * Saves a new policy version (ops lead only), then re-applies it to untouched lots already on the desk. Input:
 * `{ rules }`. `moved` counts the lots this save moved to autopilot and back to planners.
 */
export async function updatePolicy(
  env: Env,
  actor: User,
  input: unknown,
): Promise<Result<{ policy: CurrentPolicy; version: number; moved: PolicyMoved }>> {
  const valid = validRules(actor, input);
  if (!valid.ok) return valid;
  const policy = await savePolicy(env, valid.rules, actor.email);
  const moved = await reapplyPolicy(env, policy);
  return { ok: true, policy, version: policy.version, moved };
}

/**
 * What saving these rules would move, without saving anything (ops lead only). Input: `{ rules }`, validated exactly as
 * `updatePolicy` validates it. Uses the same selection as the save; a lot that changes between the preview and the save
 * (a commit, a cancel) is re-checked by the save itself.
 */
export async function previewPolicy(env: Env, actor: User, input: unknown): Promise<Result<PolicyPreview>> {
  const valid = validRules(actor, input);
  if (!valid.ok) return valid;
  const { rows, reroutes } = await selectReroutes(env, valid.rules);
  const pick = (to: Reroute["to"]) => reroutes.filter((r) => r.to === to).map((r) => lotRef(rows.get(r.lotId)!));
  return { ok: true, toAutopilot: pick("autopilot"), toPlanner: pick("planner") };
}
