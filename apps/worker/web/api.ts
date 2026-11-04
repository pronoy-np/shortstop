import type { Allocation, BoardView, LotView, NoticeView, ProposalView, Role, SiteView, UserView } from "@shortstop/shared";

export type { Allocation, Role };
export type User = UserView;
export type Proposal = ProposalView;
export type Lot = LotView;
export type Notice = NoticeView;
export type Site = SiteView;
export type Board = BoardView;

const KEY = "shortstop.as";

export const identity = {
  get: (): string | null => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (email: string) => {
    try {
      localStorage.setItem(KEY, email);
    } catch {
      // private mode: identity lasts for this page only
    }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.error ?? `HTTP ${status}`));
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const as = identity.get();
  if (as) headers.set("x-demo-user", as);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body: body ?? null });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data as Record<string, unknown>);
  return data as T;
}

export function boardSocketUrl(): string {
  const url = new URL("/api/board/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const as = identity.get();
  if (as) url.searchParams.set("as", as);
  return url.toString();
}

export const fileUrl = (key: string) => {
  const as = identity.get();
  return `/api/files?key=${encodeURIComponent(key)}${as ? `&as=${encodeURIComponent(as)}` : ""}`;
};

export const roleLabel: Record<Role, string> = { planner: "Planner", pharmacist: "Pharmacist", ops_lead: "Ops lead" };

/** Does this lot wait on the signed-in person? Planners act on open lots; pharmacists review substitutes. */
export function needsMe(lot: Lot, role: Role): boolean {
  if (role === "pharmacist") return lot.status === "needs_pharmacist";
  return lot.status === "open";
}

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

export const ACTION_LABEL = { auto_commit: "auto-commit", propose: "propose", manual_only: "manual only" } as const;

export const classLabel = (c: string) => c.replaceAll("_", " ");

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 min ago" for the last day, then a short date. The exact ISO time goes in a title attribute. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const fmt = new Intl.NumberFormat();

/** Extraction often returns letterhead capitals ("HARBORLINE PHARMACEUTICAL"); show them in title case. */
export function displayName(s: string): string {
  if (s !== s.toUpperCase() || !/[A-Z]{3}/.test(s)) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
