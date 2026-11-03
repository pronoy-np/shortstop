import { env, exports } from "cloudflare:workers";

export const PLANNER = "priya@shortstop.demo";
export const PLANNER_2 = "marcus@shortstop.demo";
export const PHARMACIST = "dana@shortstop.demo";
export const OPS_LEAD = "olu@shortstop.demo";

let counter = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Creates a notice + lot row in D1 and initialises its LotDO. */
export async function makeLot(opts: { drugId?: string; quantity?: number; substitutePending?: boolean } = {}) {
  const noticeId = uid("n");
  const lotId = `${noticeId}-1`;
  const quantity = opts.quantity ?? 500;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notices (id, r2_key, filename, content_type, status, created_by, created_at) VALUES (?, 'k', 'f.txt', 'text/plain', 'ready', ?, ?)`,
    ).bind(noticeId, PLANNER, Date.now()),
    env.DB.prepare(
      `INSERT INTO lots (id, notice_id, drug_id, quantity, remaining, status, action, proposal_json, explanation, substitute_id, substitute_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'propose', '{"allocations":[],"coverAfter":{}}', 'test', ?, ?, ?)`,
    ).bind(
      lotId,
      noticeId,
      opts.drugId ?? "cisplatin",
      quantity,
      quantity,
      opts.substitutePending ? "needs_pharmacist" : "open",
      opts.substitutePending ? "carboplatin" : null,
      opts.substitutePending ? "pending" : null,
      Date.now(),
    ),
  ]);
  const stub = env.LOT_DO.get(env.LOT_DO.idFromName(lotId));
  await stub.init(lotId, quantity);
  return { noticeId, lotId, stub };
}

export function call(path: string, init: RequestInit & { as?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.as) headers.set("x-demo-user", init.as);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return exports.default.fetch(new Request(`https://shortstop.test${path}`, { ...init, headers, body: body ?? null }));
}

export async function lotRow(lotId: string) {
  return env.DB.prepare(`SELECT * FROM lots WHERE id = ?`).bind(lotId).first<Record<string, unknown>>();
}
