import { z } from "zod";
import type { Allocation, LotStatus, NoticeStatus, PolicyAction, Role } from "./schemas";

/**
 * Response shapes of the board API. The Worker builds them and the browser reads them,
 * so a field change is a compile error on both sides instead of a silent mismatch.
 */
export type UserView = { email: string; name: string; role: Role };

export type ProposalView = { allocations: Allocation[]; coverAfter: Record<string, number>; minCoverAfter?: number; shortfall?: boolean };

export type CommitView = { lotId: string; siteId: string; quantity: number; kind: "manual" | "auto"; actor: string; commitKey: string; at: number };

export type LotView = {
  id: string;
  noticeId: string;
  drug: { id: string; name: string; drugClass: string; tier: number; unit: string };
  quantity: number;
  remaining: number;
  eta: string | null;
  status: LotStatus;
  action: PolicyAction;
  ruleId: string | null;
  policyVersion: number | null;
  hardFloor: string | null;
  proposal: ProposalView;
  explanation: string;
  substitute: { id: string; name: string; note: string | null; status: string } | null;
  finalizesAt: number | null;
  precedent: { note: string; sources: string[] } | null;
  committed: CommitView[];
  /**
   * The last time a policy save moved this lot between autopilot and planners ("Moved to autopilot by policy v3",
   * "Moved back to planners by policy v3"). `at` is epoch ms. Null when no policy save has moved it.
   */
  rerouted: { policyVersion: number; to: "autopilot" | "planner"; at: number } | null;
  /** Fresh split of what is left on an open lot. Only set when the board is loaded with `freshSplits`. */
  freshProposal?: ProposalView;
};

export type NoticeView = {
  id: string;
  filename: string;
  status: NoticeStatus;
  wholesaler: string | null;
  noticeRef: string | null;
  confidence: number | null;
  error: string | null;
  createdBy: string;
  createdAt: number;
  /**
   * Where the notice stands for a person: `reading` (received or processing: the pipeline is on it), `triage`
   * (needs_triage or failed: someone has to look, and may dismiss it) or `ready` (lots planned). Dismissed notices are
   * never on the board.
   */
  stage: NoticeStage;
  lots: LotView[];
};

export type NoticeStage = "reading" | "triage" | "ready";

/** The board stage of a notice status (dismissed notices are not on the board; they map to `ready` for completeness). */
export const noticeStage = (status: NoticeStatus): NoticeStage =>
  status === "received" || status === "processing" ? "reading" : status === "needs_triage" || status === "failed" ? "triage" : "ready";

/** Notice statuses a person may dismiss from triage. */
export const DISMISSABLE_NOTICE_STATUSES = ["needs_triage", "failed"] as const satisfies readonly NoticeStatus[];

/** Why a triage notice was dismissed: short free text. */
export const DismissReason = z.string().trim().min(1, "say why you are dismissing it").max(200, "keep the reason under 200 characters");

/** A lot named in a policy preview. `noticeLabel` is the wholesaler and notice reference, or the file name. */
export type LotRef = { lotId: string; drugName: string; noticeLabel: string };

/** What saving a policy would move (preview), or did move (save). */
export type PolicyPreview = { toAutopilot: LotRef[]; toPlanner: LotRef[] };
export type PolicyMoved = { toAutopilot: number; toPlanner: number };

export type SiteView = { id: string; name: string; acuity: number };
export type BoardView = { notices: NoticeView[]; sites: SiteView[]; viewers: string[] };

/** Cancel the pending auto-commit, or take it over to edit and commit by hand. */
export const ReservationMode = z.enum(["cancel", "takeover"]);
export type ReservationMode = z.infer<typeof ReservationMode>;

export const sumQuantity = (allocations: readonly { quantity: number }[]) => allocations.reduce((s, a) => s + a.quantity, 0);

/**
 * One RFC 4180 CSV cell: always quoted, inner quotes doubled. Text starting with = + - @ tab or CR gets a leading
 * apostrophe so Excel and Sheets show it instead of running it as a formula (CSV injection). Numbers pass through.
 */
export const csvCell = (v: string | number) => {
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return `"${s.replaceAll('"', '""')}"`;
};
