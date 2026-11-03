import { CommitRequest, PolicyRules, SubstituteDecision, type IntakeMessage, type LotStatus, type PolicyAction } from "@shortstop/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { CoverSnapshot } from "./cron";
import { rescoreCover } from "./cron";
import { audit, batchAudited } from "./lib/audit";
import { DEMO_DOMAIN, authenticate, requireRole, type AppEnv } from "./lib/auth";
import { boardStub, broadcast } from "./lib/board";
import { lotStub, splitAvailable } from "./lib/lots";
import { getPolicy, savePolicy } from "./lib/policy-store";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const NoticeUpload = z.union([
  z.object({
    file: z
      .instanceof(File)
      .refine((f) => f.size > 0, "file is empty")
      .refine((f) => f.size <= MAX_UPLOAD_BYTES, "file larger than 5 MB"),
  }),
  z.object({ text: z.string().trim().min(1).max(100_000, "text too long") }),
]);

const ReservationAction = z.object({ mode: z.enum(["cancel", "takeover"]), key: z.string().min(8).max(100) });
const SubstituteBody = z.object({ decision: SubstituteDecision, note: z.string().max(500).optional() });
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), entityId: z.string().max(100).optional() });
const FileKey = z.object({ key: z.string().regex(/^(notices|confirmations)\/[a-zA-Z0-9_:.-]+\/[a-zA-Z0-9_:.-]+$/) });

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
  created_at: number;
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

api.get("/me", (c) => c.json(c.get("user")));

api.get("/board", async (c) => {
  const env = c.env;
  const { results: notices } = await env.DB.prepare(
    `SELECT id, filename, status, wholesaler, notice_ref AS noticeRef, confidence, error, created_by AS createdBy, created_at AS createdAt
       FROM notices ORDER BY created_at DESC LIMIT 25`,
  ).all<{ id: string }>();
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
      .all<{ lotId: string }>(),
    env.DB.prepare(`SELECT id, name, acuity FROM sites ORDER BY acuity, name`).all(),
    boardStub(env)
      .viewers()
      .catch(() => [] as string[]),
  ]);

  const lotView = lots.map((l) => ({
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
      ? { id: l.substitute_id, name: l.substitute_name, note: l.substitute_note, status: l.substitute_status }
      : null,
    finalizesAt: l.finalizes_at,
    committed: allocs.filter((a) => a.lotId === l.id),
  }));
  return c.json({
    notices: notices.map((n) => ({ ...n, lots: lotView.filter((l) => l.noticeId === n.id) })),
    sites,
    viewers,
  });
});

api.post("/notices", requireRole("planner", "ops_lead"), async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "expected multipart form" }, 400);
  const file = form.get("file");
  const parsed = NoticeUpload.safeParse(file instanceof File && file.size > 0 ? { file } : { text: form.get("text") ?? "" });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid upload";
    return c.json({ error: /larger|long/.test(message) ? message : "attach a file or paste the notice text" }, /larger|long/.test(message) ? 413 : 400);
  }
  let body: ArrayBuffer | string;
  let filename: string;
  let contentType: string;
  if ("file" in parsed.data) {
    const f = parsed.data.file;
    body = await f.arrayBuffer();
    filename = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "notice";
    contentType = f.type || (filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".eml") ? "message/rfc822" : "text/plain");
  } else {
    body = parsed.data.text;
    filename = "pasted.txt";
    contentType = "text/plain";
  }

  const user = c.get("user");
  const noticeId = `n_${crypto.randomUUID().slice(0, 8)}`;
  const r2Key = `notices/${noticeId}/${filename}`;
  await c.env.FILES.put(r2Key, body, { httpMetadata: { contentType } });
  await batchAudited(
    c.env,
    [
      c.env.DB.prepare(
        `INSERT INTO notices (id, r2_key, filename, content_type, status, created_by, created_at) VALUES (?, ?, ?, ?, 'received', ?, ?)`,
      ).bind(noticeId, r2Key, filename, contentType, user.email, Date.now()),
    ],
    [{ id: `notice:${noticeId}:received`, entity: "notice", entityId: noticeId, action: "notice.received", actor: user.email, payload: { filename, contentType } }],
  );
  const msg: IntakeMessage = { noticeId, r2Key, contentType };
  await c.env.INTAKE_Q.send(msg);
  await broadcast(c.env, { type: "notice.updated", noticeId, status: "received" });
  return c.json({ noticeId }, 202);
});

api.post("/lots/:id/commit", requireRole("planner", "ops_lead"), async (c) => {
  const parsed = CommitRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
  const lotId = c.req.param("id");
  const lot = await c.env.DB.prepare(`SELECT drug_id, substitute_status FROM lots WHERE id = ?`)
    .bind(lotId)
    .first<{ drug_id: string; substitute_status: string | null }>();
  if (!lot) return c.json({ error: "lot not found" }, 404);
  // Hard floor: a suggested substitute must be reviewed by a pharmacist before anything ships.
  if (lot.substitute_status === "pending") return c.json({ error: "pharmacist review of the substitute is required first" }, 409);

  const { results: siteRows } = await c.env.DB.prepare(`SELECT id FROM sites`).all<{ id: string }>();
  const known = new Set(siteRows.map((s) => s.id));
  const allocations = parsed.data.allocations.filter((a) => a.quantity > 0);
  if (allocations.some((a) => !known.has(a.siteId))) return c.json({ error: "unknown site" }, 400);
  if (new Set(allocations.map((a) => a.siteId)).size !== allocations.length) return c.json({ error: "duplicate site" }, 400);
  if (allocations.length === 0) return c.json({ error: "nothing to commit" }, 400);

  const actor = c.get("user").email;
  const result = await lotStub(c.env, lotId).commit(parsed.data.commitKey, allocations, actor);
  if (result.ok) return c.json(result);

  // Lost the race (or a reservation holds stock): hand back a fresh split of what is actually left,
  // and tell every open board so stale editors rebase too.
  const rebased = await splitAvailable(c.env, lot.drug_id, result.available);
  await broadcast(c.env, { type: "lot.rebased", lotId, remaining: result.available, actor });
  return c.json({ error: result.reason, available: result.available, proposal: rebased }, 409);
});

api.post("/lots/:id/reservation", requireRole("planner", "ops_lead"), async (c) => {
  const body = ReservationAction.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "body must be { mode: cancel | takeover, key }" }, 400);
  const r = await lotStub(c.env, c.req.param("id")).cancelReservation(c.get("user").email, body.data.mode, body.data.key);
  return r.ok ? c.json(r) : c.json({ error: "no pending auto-commit on this lot", ...r }, 409);
});

api.post("/lots/:id/substitute", requireRole("pharmacist"), async (c) => {
  const body = SubstituteBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "decision must be approved or rejected" }, 400);
  const lotId = c.req.param("id");
  const user = c.get("user");
  // One transaction: the audit row is only written if this request's UPDATE is what made the decision.
  const res = await batchAudited(
    c.env,
    [
      c.env.DB.prepare(
        `UPDATE lots SET substitute_status = ?, status = CASE WHEN status = 'needs_pharmacist' THEN 'open' ELSE status END
          WHERE id = ? AND substitute_status = 'pending'`,
      ).bind(body.data.decision, lotId),
    ],
    [
      {
        id: `lot:${lotId}:substitute`,
        entity: "lot",
        entityId: lotId,
        action: `lot.substitute_${body.data.decision}`,
        actor: user.email,
        payload: body.data,
        onlyIf: { sql: `SELECT 1 FROM lots WHERE id = ? AND substitute_status = ?`, binds: [lotId, body.data.decision] },
      },
    ],
  );
  if (!res[0]?.meta.changes) return c.json({ error: "no pending substitute on this lot" }, 409);
  await broadcast(c.env, { type: "lot.substitute", lotId, status: body.data.decision });
  return c.json({ ok: true });
});

// Fresh split of whatever is still available (after partial commits or a cancelled reservation).
api.get("/lots/:id/proposal", async (c) => {
  const lot = await c.env.DB.prepare(`SELECT drug_id FROM lots WHERE id = ?`).bind(c.req.param("id")).first<{ drug_id: string }>();
  if (!lot) return c.json({ error: "lot not found" }, 404);
  const state = await lotStub(c.env, c.req.param("id")).state();
  return c.json({ available: state.available, proposal: await splitAvailable(c.env, lot.drug_id, state.available) });
});

api.get("/lots/:id/confirmations", async (c) => {
  const list = await c.env.FILES.list({ prefix: `confirmations/${c.req.param("id")}/` });
  return c.json({ keys: list.objects.map((o) => o.key) });
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

api.get("/policy", async (c) => {
  const current = await getPolicy(c.env);
  const { results: versions } = await c.env.DB.prepare(
    `SELECT version, created_by AS createdBy, created_at AS createdAt, rules_json AS rulesJson FROM policy_versions ORDER BY version DESC LIMIT 20`,
  ).all<{ rulesJson: string }>();
  return c.json({ current, versions: versions.map(({ rulesJson, ...v }) => ({ ...v, rules: JSON.parse(rulesJson) })) });
});

api.put("/policy", requireRole("ops_lead"), async (c) => {
  const body = z.object({ rules: PolicyRules }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid rules" }, 400);
  return c.json(await savePolicy(c.env, body.data.rules, c.get("user").email));
});

api.get("/audit", async (c) => {
  const q = AuditQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "limit must be 1-500" }, 400);
  const { limit, entityId } = q.data;
  const stmt = entityId
    ? c.env.DB.prepare(`SELECT * FROM audit_log WHERE entity_id = ? ORDER BY at DESC LIMIT ?`).bind(entityId, limit)
    : c.env.DB.prepare(`SELECT * FROM audit_log ORDER BY at DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all<{ payload_json: string }>();
  return c.json({ entries: results.map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) })) });
});

api.get("/metrics", async (c) => {
  const env = c.env;
  const [notices, lots, units, cancels, timing, dead] = await env.DB.batch([
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM notices GROUP BY status`),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM lots GROUP BY status`),
    env.DB.prepare(`SELECT kind, SUM(quantity) AS units, COUNT(DISTINCT lot_id) AS lots FROM allocations GROUP BY kind`),
    env.DB.prepare(`SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN ('lot.reservation_cancelled', 'lot.taken_over') GROUP BY action`),
    env.DB.prepare(
      `SELECT AVG(first_at - created_at) AS avgMs FROM (SELECT l.created_at, MIN(a.at) AS first_at FROM lots l JOIN allocations a ON a.lot_id = l.id GROUP BY l.id)`,
    ),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters`),
  ]);
  const cover = (await env.CACHE.get<CoverSnapshot>("cover:snapshot", "json")) ?? (await rescoreCover(env));
  return c.json({
    notices: notices!.results,
    lots: lots!.results,
    units: units!.results,
    overrides: cancels!.results,
    avgMinutesToFirstCommit: ((timing!.results[0] as { avgMs: number | null })?.avgMs ?? 0) / 60_000,
    deadLetters: (dead!.results[0] as { n: number }).n,
    cover,
  });
});

api.get("/export/allocations.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.at, a.lot_id, d.name AS drug, si.name AS site, a.quantity, a.kind, a.actor
       FROM allocations a JOIN lots l ON l.id = a.lot_id JOIN drugs d ON d.id = l.drug_id JOIN sites si ON si.id = a.site_id
      ORDER BY a.at`,
  ).all<Record<string, string | number>>();
  const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
  const header = "committed_at,lot_id,drug,site,quantity,kind,actor";
  const lines = results.map((r) => [new Date(Number(r.at)).toISOString(), r.lot_id, r.drug, r.site, r.quantity, r.kind, r.actor].map((v) => cell(v!)).join(","));
  await audit(c.env, { entity: "system", entityId: "export", action: "allocations.exported", actor: c.get("user").email, payload: { rows: results.length } });
  return new Response([header, ...lines].join("\n"), {
    headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=allocations.csv" },
  });
});

api.get("/board/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-shortstop-user", c.get("user").name);
  return boardStub(c.env).fetch(new Request(c.req.raw.url, { headers }));
});
