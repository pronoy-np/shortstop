import type { LotView, Role } from "@shortstop/shared";

// Display helpers shared by server pages and client islands (no data access here).

export const roleLabel: Record<Role, string> = { planner: "Planner", pharmacist: "Pharmacist", ops_lead: "Ops lead" };

/** Does this lot wait on the signed-in person? Planners act on open lots; pharmacists review substitutes. */
export function needsMe(lot: LotView, role: Role): boolean {
  if (role === "pharmacist") return lot.status === "needs_pharmacist";
  return lot.status === "open";
}

/** Planners and the ops lead commit lots and handle triage; pharmacists review substitutes. */
export const canPlan = (role: Role) => role === "planner" || role === "ops_lead";

export const TIER_HINT: Record<number, string> = {
  1: "Tier 1: critical",
  2: "Tier 2: important",
  3: "Tier 3: routine",
};

export const STATUS_HINT: Record<string, string> = {
  open: "A planner commits it",
  needs_pharmacist: "Substitute to review",
  reserved: "Commits on its own soon",
  committed: "Stock sent",
};

export const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  processing: "Reading",
  ready: "Ready",
  needs_triage: "Needs triage",
  failed: "Failed",
  open: "Awaiting planner",
  needs_pharmacist: "Awaiting pharmacist",
  reserved: "Autopilot pending",
  committed: "Committed",
  dismissed: "Dismissed",
};

export type PolicyActionName = "auto_commit" | "propose" | "manual_only";
export const POLICY_ACTIONS: [PolicyActionName, string][] = [
  ["auto_commit", "Auto-commit (15 min window)"],
  ["propose", "Propose to a planner"],
  ["manual_only", "Manual only"],
];

export const ACTION_LABEL = { auto_commit: "auto-commit", propose: "propose", manual_only: "manual only" } as const;

/**
 * Why a notice needs a person, as one short line. The pipeline stores terse reasons ("unmatched product: X",
 * "not an allocation notice"); anything else is shown as stored, capitalised.
 */
export function triageReason(error: string | null): string {
  if (!error) return "Could not be read";
  const unmatched = /^unmatched product: (.+)$/i.exec(error.split("; ")[0]!);
  if (unmatched) return `${unmatched[1]} isn't in the catalog`;
  const zero = /^zero allocation: (.+)$/i.exec(error);
  if (zero) return `${zero[1]} has a zero allocation`;
  if (/^not an allocation notice$/i.test(error)) return "Not an allocation notice";
  if (/^no catalog drugs matched$/i.test(error)) return "No drug matches the catalog";
  return error.charAt(0).toUpperCase() + error.slice(1);
}

export const classLabel = (c: string) => c.replaceAll("_", " ");

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
/** "3 min ago" for the last day, then a short date. The exact ISO time goes in a title attribute. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return new Date(at).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
}

export const fmt = new Intl.NumberFormat("en");

/** Extraction often returns letterhead capitals ("HARBORLINE PHARMACEUTICAL"); show them in title case. */
export function displayName(s: string): string {
  if (s !== s.toUpperCase() || !/[A-Z]{3}/.test(s)) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Stored notices and confirmations. The `demo_user` cookie authenticates the link, so no `?as=` is needed. */
export const fileUrl = (key: string) => `/api/files?key=${encodeURIComponent(key)}`;
