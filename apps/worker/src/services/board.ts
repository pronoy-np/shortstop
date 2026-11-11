import { noticeStage, type BoardView, type CommitView, type LotStatus, type LotView, type NoticeView, type PolicyAction } from "@shortstop/shared";
import { boardStub } from "../lib/board";
import { loadSiteStock } from "../lib/db";
import { splitWithBase } from "../lib/lots";

type LotRow = {
  id: string;
  notice_id: string;
  drug_id: string;
  drug_name: string;
  drug_class: string;
  tier: number;
  unit: string;
  quantity: number;
  remaining: number;
  eta: string | null;
  status: LotStatus;
  action: PolicyAction;
  rule_id: string | null;
  policy_version: number | null;
  hard_floor: string | null;
  proposal_json: string;
  explanation: string;
  substitute_id: string | null;
  substitute_name: string | null;
  substitute_note: string | null;
  substitute_status: string | null;
  finalizes_at: number | null;
  precedent_note: string | null;
  precedent_sources_json: string | null;
  rerouted_to: "autopilot" | "planner" | null;
  rerouted_version: number | null;
  rerouted_at: number | null;
  created_at: number;
};

/**
 * The notices the desk shows (never dismissed ones): the 25 newest, plus any older one that still has a lot waiting on someone (open, awaiting a
 * pharmacist, or reserved), so work never drops off the board just because newer notices arrived. At most 100, newest
 * first. `countNeedsMe` uses the same rule, so its count matches the board.
 */
export const BOARD_NOTICE_IDS_SQL = `SELECT id FROM (
  SELECT id, created_at FROM notices
   WHERE status != 'dismissed'
     AND (id IN (SELECT id FROM notices WHERE status != 'dismissed' ORDER BY created_at DESC LIMIT 25)
      OR id IN (SELECT notice_id FROM lots WHERE status IN ('open', 'needs_pharmacist', 'reserved')))
   ORDER BY created_at DESC LIMIT 100)`;

/**
 * An open lot with stock left: its stored proposal was computed when the notice came in, so it is stale as soon as any
 * lot of the same drug (or this one) commits, because commits change every site's supply.
 */
const needsFreshSplit = (l: LotView) => l.status === "open" && l.remaining > 0;

/**
 * The board: the notices in `BOARD_NOTICE_IDS_SQL` with their lots and commits, the sites, and who is watching.
 * `freshSplits` adds `freshProposal` (a split of `remaining`, from the D1 projection) to every open lot with stock left,
 * so a server-rendered board needs no per-lot `/proposal` refetch. Stock held by a pending autopilot reservation is not in
 * `allocations` yet, so it is not counted in supply until it finalises. The JSON API leaves it off, so its body is unchanged.
 */
export async function loadBoard(env: Env, opts: { freshSplits?: boolean } = {}): Promise<BoardView> {
  const { results: notices } = await env.DB.prepare(
    `SELECT id, filename, status, wholesaler, notice_ref AS noticeRef, confidence, error, created_by AS createdBy, created_at AS createdAt
       FROM notices WHERE id IN (${BOARD_NOTICE_IDS_SQL}) ORDER BY created_at DESC`,
  ).all<Omit<NoticeView, "lots" | "stage">>();
  // Bind the ids just read (at most 100, D1's limit) so the three queries describe the same set of notices.
  const ids = notices.map((n) => n.id);
  const marks = ids.map(() => "?").join(",") || "''";
  const [{ results: lots }, { results: allocs }, { results: sites }, viewers] = await Promise.all([
    env.DB.prepare(
      `SELECT l.*, d.name AS drug_name, d.drug_class, d.tier, d.unit, s.name AS substitute_name, sub.note AS substitute_note
         FROM lots l JOIN drugs d ON d.id = l.drug_id
         LEFT JOIN drugs s ON s.id = l.substitute_id
         LEFT JOIN substitutes sub ON sub.drug_id = l.drug_id AND sub.substitute_id = l.substitute_id
        WHERE l.notice_id IN (${marks}) ORDER BY l.id`,
    )
      .bind(...ids)
      .all<LotRow>(),
    env.DB.prepare(
      `SELECT a.lot_id AS lotId, a.site_id AS siteId, a.quantity, a.kind, a.actor, a.commit_key AS commitKey, a.at
         FROM allocations a JOIN lots l ON l.id = a.lot_id WHERE l.notice_id IN (${marks}) ORDER BY a.at`,
    )
      .bind(...ids)
      .all<CommitView>(),
    env.DB.prepare(`SELECT id, name, acuity FROM sites ORDER BY acuity, name`).all<BoardView["sites"][number]>(),
    boardStub(env)
      .viewers()
      .catch(() => [] as string[]),
  ]);

  const lotView = lots.map((l): LotView => ({
    id: l.id,
    noticeId: l.notice_id,
    drug: { id: l.drug_id, name: l.drug_name, drugClass: l.drug_class, tier: l.tier, unit: l.unit },
    quantity: l.quantity,
    remaining: l.remaining,
    eta: l.eta,
    status: l.status,
    action: l.action,
    ruleId: l.rule_id,
    policyVersion: l.policy_version,
    hardFloor: l.hard_floor,
    proposal: JSON.parse(l.proposal_json),
    explanation: l.explanation,
    substitute: l.substitute_id
      ? { id: l.substitute_id, name: l.substitute_name ?? l.substitute_id, note: l.substitute_note, status: l.substitute_status ?? "pending" }
      : null,
    finalizesAt: l.finalizes_at,
    precedent: l.precedent_note ? { note: l.precedent_note, sources: JSON.parse(l.precedent_sources_json ?? "[]") as string[] } : null,
    committed: allocs.filter((a) => a.lotId === l.id),
    rerouted:
      l.rerouted_to && l.rerouted_version !== null && l.rerouted_at !== null
        ? { policyVersion: l.rerouted_version, to: l.rerouted_to, at: l.rerouted_at }
        : null,
  }));
  if (opts.freshSplits) {
    // One stock read per drug, however many of its lots are open.
    const stale = lotView.filter(needsFreshSplit);
    const stock = new Map(await Promise.all([...new Set(stale.map((l) => l.drug.id))].map(async (id) => [id, await loadSiteStock(env, id)] as const)));
    for (const l of stale) l.freshProposal = splitWithBase(l.remaining, stock.get(l.drug.id)!);
  }
  return {
    notices: notices.map((n) => ({ ...n, stage: noticeStage(n.status), lots: lotView.filter((l) => l.noticeId === n.id) })),
    sites,
    viewers,
  };
}
