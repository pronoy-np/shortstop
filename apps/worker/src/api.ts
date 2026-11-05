import { NoticeText } from "@shortstop/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { DEMO_DOMAIN, authenticate, type AppEnv } from "./lib/auth";
import { boardStub } from "./lib/board";
import { workersAi } from "./lib/ai";
import { limitWrites } from "./lib/ratelimit";
import { searchLots } from "./search";
import { loadAudit } from "./services/audit";
import { loadBoard } from "./services/board";
import { cancelReservation, commitLot, listConfirmations, loadProposal, reviewSubstitute } from "./services/lots";
import { exportAllocationsCsv, loadMetrics } from "./services/metrics";
import { MAX_UPLOAD_BYTES, submitNotice } from "./services/notices";
import { loadPolicy, updatePolicy } from "./services/policy";
import { isRecord, type Fail, type FailCode } from "./services/result";

const SearchQuery = z.object({ q: z.string().trim().min(2).max(200), k: z.coerce.number().int().min(1).max(20).default(8) });
const FileKey = z.object({ key: z.string().regex(/^(notices|confirmations)\/[a-zA-Z0-9_:.-]+\/[a-zA-Z0-9_:.-]+$/) });

const STATUS = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  key_conflict: 422,
} as const satisfies Record<FailCode, ContentfulStatusCode>;

/** A service failure as the API's error body: `{ error: message, ...extra }`. Field errors stay out of the JSON API. */
function failure(c: Context<AppEnv>, r: Fail) {
  const { ok: _ok, code, message, fieldErrors: _fe, ...extra } = r;
  return c.json({ error: message, ...extra }, STATUS[code]);
}

/** The JSON body as an object to spread into a service input (anything else becomes `{}` and fails validation there). */
const jsonBody = async (c: Context<AppEnv>) => {
  const body: unknown = await c.req.json().catch(() => null);
  return isRecord(body) ? body : {};
};

export const api = new Hono<AppEnv>().basePath("/api");

api.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

api.get("/health", (c) => c.json({ ok: true }));

// Demo identity switcher (only exposed when demo auth is on).
api.get("/users", async (c) => {
  if (c.env.ACCESS_AUD || c.env.DEMO_AUTH !== "true") return c.json({ users: [], demo: false });
  const { results } = await c.env.DB.prepare(`SELECT email, name, role FROM users WHERE email LIKE ? ORDER BY role, name`)
    .bind(`%${DEMO_DOMAIN}`)
    .all();
  return c.json({ users: results, demo: true });
});

api.use("*", authenticate);
api.use("*", limitWrites);

api.get("/me", (c) => c.json(c.get("user")));

api.get("/board", async (c) => c.json(await loadBoard(c.env)));

api.post("/notices", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "expected multipart form" }, 400);
  const file = form.get("file");
  const text = form.get("text");
  // Size is a transport concern (413); the service validates the same limits again for other callers.
  if (file instanceof File && file.size > MAX_UPLOAD_BYTES) return c.json({ error: "file larger than 5 MB" }, 413);
  if (!(file instanceof File && file.size > 0) && typeof text === "string") {
    const tooBig = NoticeText.safeParse(text).error?.issues.find((i) => i.code === "too_big");
    if (tooBig) return c.json({ error: tooBig.message }, 413);
  }
  const r = await submitNotice(c.env, c.get("user"), { file, text });
  return r.ok ? c.json({ noticeId: r.noticeId }, 202) : failure(c, r);
});

api.post("/lots/:id/commit", async (c) => {
  // Idempotency-Key header wins over the body commitKey (resolved in the service).
  const r = await commitLot(c.env, c.get("user"), {
    ...(await jsonBody(c)),
    lotId: c.req.param("id"),
    idempotencyKey: c.req.header("Idempotency-Key"),
  });
  return r.ok ? c.json(r) : failure(c, r);
});

api.post("/lots/:id/reservation", async (c) => {
  const r = await cancelReservation(c.env, c.get("user"), { ...(await jsonBody(c)), lotId: c.req.param("id") });
  return r.ok ? c.json(r) : failure(c, r);
});

api.post("/lots/:id/substitute", async (c) => {
  const r = await reviewSubstitute(c.env, c.get("user"), { ...(await jsonBody(c)), lotId: c.req.param("id") });
  return r.ok ? c.json({ ok: true }) : failure(c, r);
});

api.get("/lots/:id/proposal", async (c) => {
  const r = await loadProposal(c.env, c.req.param("id"));
  return r.ok ? c.json({ available: r.available, proposal: r.proposal }) : failure(c, r);
});

// Search lots by meaning (Workers AI embeddings + Vectorize).
api.get("/search", async (c) => {
  const q = SearchQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "q must be 2-200 characters" }, 400);
  let hits;
  try {
    hits = await searchLots({ ai: workersAi(c.env), vec: c.env.VEC }, q.data.q, q.data.k);
  } catch (err) {
    console.warn("search unavailable", err);
    return c.json({ error: "search is temporarily unavailable" }, 503);
  }
  const ids = hits.map((h) => h.lotId);
  const { results } = ids.length
    ? await c.env.DB.prepare(
        `SELECT l.id, l.notice_id AS noticeId, l.status, l.quantity, l.remaining, d.name AS drugName
           FROM lots l JOIN drugs d ON d.id = l.drug_id WHERE l.id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<{ id: string }>()
    : { results: [] as { id: string }[] };
  const byId = new Map(results.map((r) => [r.id, r]));
  // Vectors can outlive a reseeded D1; only return lots that still exist.
  return c.json({ hits: hits.filter((h) => byId.has(h.lotId)).map((h) => ({ ...h, lot: byId.get(h.lotId) })) });
});

api.get("/lots/:id/confirmations", async (c) => {
  const r = await listConfirmations(c.env, c.req.param("id"));
  return r.ok ? c.json({ keys: r.keys }) : failure(c, r);
});

// Serves stored notices and confirmations. Only these two prefixes are readable.
api.get("/files", async (c) => {
  const parsed = FileKey.safeParse({ key: c.req.query("key") });
  if (!parsed.success) return c.json({ error: "bad key" }, 400);
  const obj = await c.env.FILES.get(parsed.data.key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const headers = new Headers({ "content-type": contentType, "x-content-type-options": "nosniff" });
  // Uploaded HTML must never run script on our origin; confirmations only need inline styles.
  if (contentType.includes("html")) headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  else if (!/^(text\/plain|application\/pdf)/.test(contentType)) headers.set("content-disposition", "attachment");
  return new Response(obj.body, { headers });
});

api.get("/policy", async (c) => c.json(await loadPolicy(c.env)));

api.put("/policy", async (c) => {
  const r = await updatePolicy(c.env, c.get("user"), await c.req.json().catch(() => null));
  return r.ok ? c.json(r.policy) : failure(c, r);
});

api.get("/audit", async (c) => {
  const r = await loadAudit(c.env, c.req.query());
  return r.ok ? c.json({ entries: r.entries }) : failure(c, r);
});

api.get("/metrics", async (c) => c.json(await loadMetrics(c.env)));

api.get("/export/allocations.csv", async (c) => {
  const csv = await exportAllocationsCsv(c.env, c.get("user"));
  return new Response(csv, { headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=allocations.csv" } });
});

api.get("/board/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-shortstop-user", c.get("user").name);
  return boardStub(c.env).fetch(new Request(c.req.raw.url, { headers }));
});
