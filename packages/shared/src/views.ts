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
  lots: LotView[];
};

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
