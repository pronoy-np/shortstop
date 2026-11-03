export type Role = "planner" | "pharmacist" | "ops_lead";
export type User = { email: string; name: string; role: Role };
export type Allocation = { siteId: string; quantity: number };
export type Proposal = { allocations: Allocation[]; coverAfter: Record<string, number>; minCoverAfter?: number; shortfall?: boolean };

export type Lot = {
  id: string;
  noticeId: string;
  drug: { id: string; name: string; drugClass: string; tier: number; unit: string };
  quantity: number;
  remaining: number;
  eta: string | null;
  status: "open" | "needs_pharmacist" | "reserved" | "committed";
  action: "auto_commit" | "propose" | "manual_only";
  ruleId: string | null;
  policyVersion: number | null;
  hardFloor: string | null;
  proposal: Proposal;
  explanation: string;
  substitute: { id: string; name: string; note: string | null; status: string } | null;
  finalizesAt: number | null;
  committed: { siteId: string; quantity: number; kind: string; actor: string; commitKey: string; at: number }[];
};

export type Notice = {
  id: string;
  filename: string;
  status: "received" | "processing" | "ready" | "needs_triage" | "failed";
  wholesaler: string | null;
  noticeRef: string | null;
  confidence: number | null;
  error: string | null;
  createdBy: string;
  createdAt: number;
  lots: Lot[];
};

export type Site = { id: string; name: string; acuity: number };
export type Board = { notices: Notice[]; sites: Site[]; viewers: string[] };

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
