import type { LotView, Role } from "@shortstop/shared";

// Display helpers shared by server pages and client islands (no data access here).

export const roleLabel: Record<Role, string> = { planner: "Planner", pharmacist: "Pharmacist", ops_lead: "Ops lead" };

/** Does this lot wait on the signed-in person? Planners act on open lots; pharmacists review substitutes. */
export function needsMe(lot: LotView, role: Role): boolean {
  if (role === "pharmacist") return lot.status === "needs_pharmacist";
  return lot.status === "open";
}

/** One plain sentence on what an open lot is waiting for, plus a hint to switch persona when this person can't act. */
export function nextStep(lot: LotView, role: Role): string | null {
  const planner = role === "planner" || role === "ops_lead";
  switch (lot.status) {
    case "open":
      return `Waiting for a planner to review the split below and commit it.${planner ? "" : " Switch persona to a planner at the top right to act."}`;
    case "needs_pharmacist":
      return `Waiting for a pharmacist to approve or reject the suggested substitute; a planner commits after that.${role === "pharmacist" ? "" : " Switch persona to the pharmacist at the top right to review it."}`;
    case "reserved":
      return `Autopilot will commit this split when the countdown ends, unless a planner cancels or takes over.${planner ? "" : " Switch persona to a planner to step in."}`;
    default:
      return null;
  }
}

export const TIER_HINT: Record<number, string> = {
  1: "Tier 1: critical drug. A person must commit it; autopilot never will.",
  2: "Tier 2: important drug. The autopilot policy decides whether it can commit on its own.",
  3: "Tier 3: routine drug. The autopilot policy decides whether it can commit on its own.",
};

export const STATUS_HINT: Record<string, string> = {
  open: "Waiting for a planner to commit the split.",
  needs_pharmacist: "A substitute is suggested; a pharmacist must review it first.",
  reserved: "Autopilot will commit when the 15-minute window ends. A planner can cancel or take over until then.",
  committed: "The stock is committed to the sites.",
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
};

export type PolicyActionName = "auto_commit" | "propose" | "manual_only";
export const POLICY_ACTIONS: [PolicyActionName, string][] = [
  ["auto_commit", "Auto-commit (15 min window)"],
  ["propose", "Propose to a planner"],
  ["manual_only", "Manual only"],
];

export const ACTION_LABEL = { auto_commit: "auto-commit", propose: "propose", manual_only: "manual only" } as const;

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
