import type { PolicyRule } from "@shortstop/shared";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dismissNoticeForm, policyForm, previewPolicyForm } from "../src/actions/forms";
import type { User } from "../src/lib/auth";
import { loadBoard } from "../src/services/board";
import { commitLot } from "../src/services/lots";
import { dismissNotice } from "../src/services/notices";
import { previewPolicy, reapplyPolicy, updatePolicy } from "../src/services/policy";
import { countNeedsMe } from "../src/services/users";
import { OPS_LEAD, PHARMACIST, PLANNER, call, lotRow, makeLot, uid } from "./helpers";

const user = (email: string, role: User["role"]): User => ({ email, name: email, role });
const planner = user(PLANNER, "planner");
const pharmacist = user(PHARMACIST, "pharmacist");
const opsLead = user(OPS_LEAD, "ops_lead");

// Each test routes its own drug class, so a save only ever matches the lots that test made (lots from earlier tests in
// this file stay candidates, which is why counts are checked per lot, not only as totals).
const auto = (id: string, drugClass: string, extra: PolicyRule["when"] = {}): PolicyRule => ({
  id,
  when: { drugClass, needsSubstitute: false, ...extra },
  then: "auto_commit",
});

async function save(rules: PolicyRule[]) {
  const r = await updatePolicy(env, opsLead, { rules });
  if (!r.ok) throw new Error(r.message);
  return r;
}

const auditIds = async (pattern: string) =>
  (await env.DB.prepare(`SELECT id, actor FROM audit_log WHERE id LIKE ? ORDER BY id`).bind(pattern).all<{ id: string; actor: string }>()).results;

const asForm = (email: string, path: string) =>
  new Request(`https://shortstop.test${path}`, { method: "POST", headers: { cookie: `demo_user=${encodeURIComponent(email)}` } });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("policy re-apply on save", () => {
  it("moves an untouched open lot to autopilot, then back to planners, then to autopilot again under a fresh key", async () => {
    const { lotId, stub } = await makeLot({ drugId: "famotidine", quantity: 40 });

    const v1 = await save([auto("gi-auto", "gi")]);
    expect(v1).toMatchObject({ ok: true, version: v1.policy.version, moved: { toAutopilot: 1, toPlanner: 0 } });
    const a = v1.version;
    expect(await lotRow(lotId)).toMatchObject({
      status: "reserved",
      action: "auto_commit",
      rule_id: "gi-auto",
      policy_version: a,
      hard_floor: null,
      rerouted_to: "autopilot",
      rerouted_version: a,
    });
    expect((await stub.state()).reservation).toMatchObject({ commitKey: `auto:${lotId}:v${a}`, ruleId: "gi-auto", policyVersion: a });
    expect(await auditIds(`lot:${lotId}:reserve:%`)).toEqual([{ id: `lot:${lotId}:reserve:auto:${lotId}:v${a}`, actor: `autopilot:gi-auto@v${a}` }]);
    expect(await auditIds(`lot:${lotId}:rerouted:%`)).toEqual([{ id: `lot:${lotId}:rerouted:v${a}`, actor: `autopilot:gi-auto@v${a}` }]);
    const lot = (await loadBoard(env)).notices.flatMap((n) => n.lots).find((l) => l.id === lotId)!;
    expect(lot.rerouted).toEqual({ policyVersion: a, to: "autopilot", at: expect.any(Number) });

    // The class no longer auto-commits: the reservation is cancelled and the lot goes back to planners, whole.
    const v2 = await save([{ id: "gi-propose", when: { drugClass: "gi" }, then: "propose" }]);
    const b = v2.version;
    expect(v2.moved).toEqual({ toAutopilot: 0, toPlanner: 1 });
    expect(await lotRow(lotId)).toMatchObject({
      status: "open",
      remaining: 40,
      finalizes_at: null,
      action: "propose",
      rule_id: "gi-propose",
      policy_version: b,
      rerouted_to: "planner",
      rerouted_version: b,
    });
    expect((await stub.state())).toMatchObject({ reservation: null, available: 40, committed: 0 });
    expect(await auditIds(`lot:${lotId}:cancel:%`)).toEqual([{ id: `lot:${lotId}:cancel:policy:v${b}:${lotId}`, actor: `policy:v${b}` }]);
    expect((await loadBoard(env)).notices.flatMap((n) => n.lots).find((l) => l.id === lotId)!.rerouted).toMatchObject({ policyVersion: b, to: "planner" });

    // Back to autopilot: a new versioned key, so the second reservation has its own audit row.
    const v3 = await save([auto("gi-auto", "gi")]);
    const c = v3.version;
    expect(v3.moved).toEqual({ toAutopilot: 1, toPlanner: 0 });
    expect((await auditIds(`lot:${lotId}:reserve:%`)).map((r) => r.id)).toEqual([
      `lot:${lotId}:reserve:auto:${lotId}:v${a}`,
      `lot:${lotId}:reserve:auto:${lotId}:v${c}`,
    ]);
    expect(await auditIds(`lot:${lotId}:rerouted:%`)).toHaveLength(3);
  });

  it("never moves floors, partly committed, committed or pharmacist lots, nor lots a planner took off autopilot", async () => {
    const tier1 = await makeLot({ drugId: "propofol", quantity: 30 }); // sedation, tier 1: hard floor
    const partly = await makeLot({ drugId: "lorazepam", quantity: 30 });
    const done = await makeLot({ drugId: "lorazepam", quantity: 20 });
    const pharm = await makeLot({ drugId: "lorazepam", quantity: 30, substitutePending: true });
    const reviewed = await makeLot({ drugId: "lorazepam", quantity: 30 }); // substitute approved: still a substitute case
    const cancelled = await makeLot({ drugId: "lorazepam", quantity: 30 }); // routed auto_commit, then a planner cancelled
    const control = await makeLot({ drugId: "lorazepam", quantity: 30 });
    expect(await commitLot(env, planner, { lotId: partly.lotId, commitKey: "reapply-partly", allocations: [{ siteId: "rci", quantity: 10 }] })).toMatchObject({ ok: true });
    expect(await commitLot(env, planner, { lotId: done.lotId, commitKey: "reapply-done", allocations: [{ siteId: "rci", quantity: 20 }] })).toMatchObject({ ok: true });
    await env.DB.batch([
      env.DB.prepare(`UPDATE lots SET substitute_id = 'midazolam', substitute_status = 'approved' WHERE id = ?`).bind(reviewed.lotId),
      env.DB.prepare(`UPDATE lots SET action = 'auto_commit', rule_id = 'old-auto', policy_version = 1 WHERE id = ?`).bind(cancelled.lotId),
    ]);
    const before = Object.fromEntries(
      await Promise.all([tier1, partly, done, pharm, reviewed, cancelled].map(async (l) => [l.lotId, await lotRow(l.lotId)] as const)),
    );

    const saved = await save([auto("sed-auto", "sedation")]);
    expect(await lotRow(control.lotId)).toMatchObject({ status: "reserved", rerouted_to: "autopilot", rerouted_version: saved.version });
    for (const [id, row] of Object.entries(before)) {
      const after = await lotRow(id);
      expect(after, id).toEqual(row);
      expect(await auditIds(`lot:${id}:rerouted:%`), id).toEqual([]);
    }
    expect((await tier1.stub.state()).reservation).toBeNull();
    expect((await partly.stub.state()).reservation).toBeNull();
  });

  it("is idempotent: a second save or a re-run for the same version moves nothing more", async () => {
    const { lotId } = await makeLot({ drugId: "furosemide", quantity: 25 });
    const rules = [auto("diur-auto", "diuretic")];
    const first = await save(rules);
    expect(first.moved.toAutopilot).toBeGreaterThanOrEqual(1);
    const row = await lotRow(lotId);
    expect(row).toMatchObject({ status: "reserved", rerouted_version: first.version });

    expect(await reapplyPolicy(env, first.policy)).toEqual({ toAutopilot: 0, toPlanner: 0 });
    const second = await save(rules);
    expect(second.moved).toEqual({ toAutopilot: 0, toPlanner: 0 });
    expect(await lotRow(lotId)).toEqual(row);
    expect(await auditIds(`lot:${lotId}:rerouted:%`)).toHaveLength(1);
    expect(await auditIds(`lot:${lotId}:reserve:%`)).toHaveLength(1);
  });

  it("the LotDO refuses a re-reservation once anything was committed (checked inside the DO)", async () => {
    const { lotId, stub } = await makeLot({ drugId: "metoclopramide", quantity: 50 });
    await stub.commit(`${lotId}:k1`, [{ siteId: "rci", quantity: 5 }], PLANNER);
    const r = await stub.reserveAuto({ commitKey: `auto:${lotId}:v9`, allocations: [{ siteId: "rci", quantity: 5 }], ruleId: "x", policyVersion: 9, windowMs: 60_000, untouchedOnly: true });
    expect(r).toMatchObject({ ok: false, reason: "insufficient" });
    expect((await stub.state()).reservation).toBeNull();
  });
});

describe("policy preview", () => {
  it("lists exactly the lots the save then moves, and writes nothing", async () => {
    const small = await makeLot({ drugId: "kcl-inj", quantity: 60 });
    const big = await makeLot({ drugId: "kcl-inj", quantity: 400 });
    const untouched = await makeLot({ drugId: "kcl-inj", quantity: 500 });
    // `big` is on autopilot already (routed auto_commit at ingest, reservation held).
    await env.DB.prepare(`UPDATE lots SET action = 'auto_commit', rule_id = 'old-auto', policy_version = 1 WHERE id = ?`).bind(big.lotId).run();
    await big.stub.reserveAuto({ commitKey: `auto:${big.lotId}`, allocations: [{ siteId: "rci", quantity: 100 }], ruleId: "old-auto", policyVersion: 1, windowMs: 60_000 });
    expect(await lotRow(big.lotId)).toMatchObject({ status: "reserved" });

    const rules = [auto("lyte-small", "electrolyte", { maxLotQty: 100 })];
    const versions = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM policy_versions`).first<{ n: number }>())!.n;
    const n = await versions();
    const preview = await previewPolicy(env, opsLead, { rules });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(await versions()).toBe(n);
    expect(preview.toAutopilot).toContainEqual({ lotId: small.lotId, drugName: expect.stringContaining("Potassium chloride"), noticeLabel: "f.txt" });
    expect(preview.toPlanner.map((l) => l.lotId)).toContain(big.lotId);
    expect([...preview.toAutopilot, ...preview.toPlanner].map((l) => l.lotId)).not.toContain(untouched.lotId);

    const saved = await save(rules);
    expect(saved.moved).toEqual({ toAutopilot: preview.toAutopilot.length, toPlanner: preview.toPlanner.length });
    const movedIds = async (to: string) =>
      (await env.DB.prepare(`SELECT id FROM lots WHERE rerouted_version = ? AND rerouted_to = ? ORDER BY id`).bind(saved.version, to).all<{ id: string }>()).results.map((r) => r.id);
    expect(await movedIds("autopilot")).toEqual(preview.toAutopilot.map((l) => l.lotId).sort());
    expect(await movedIds("planner")).toEqual(preview.toPlanner.map((l) => l.lotId).sort());
  });

  it("validates like a save: ops lead only, schema and checkPolicy", async () => {
    expect(await previewPolicy(env, planner, { rules: [] })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await previewPolicy(env, opsLead, { rules: "nope" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await previewPolicy(env, opsLead, { rules: [{ id: "t1", when: { tier: 1, needsSubstitute: false }, then: "auto_commit" }] })).toMatchObject({
      ok: false,
      code: "invalid",
      fieldErrors: { rules: [expect.stringContaining("hard floor")] },
    });
    expect(await previewPolicy(env, opsLead, { rules: [] })).toMatchObject({ ok: true, toAutopilot: [] });
  });

  it("is exposed as a Server Action core and POST /api/policy/preview; the save form reports what moved", async () => {
    const rules = JSON.stringify([auto("gi-auto", "gi")]);
    expect(await previewPolicyForm(env, asForm(OPS_LEAD, "/app/policy"), form({ rules }))).toMatchObject({
      ok: true,
      preview: { toAutopilot: expect.any(Array), toPlanner: expect.any(Array) },
    });
    expect(await previewPolicyForm(env, asForm(PLANNER, "/app/policy"), form({ rules }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await previewPolicyForm(env, asForm(OPS_LEAD, "/app/policy"), form({ rules: "{" }))).toMatchObject({ ok: false, code: "invalid" });

    const res = await call("/api/policy/preview", { method: "POST", as: OPS_LEAD, json: { rules: JSON.parse(rules) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ toAutopilot: expect.any(Array), toPlanner: expect.any(Array) });
    expect((await call("/api/policy/preview", { method: "POST", as: PLANNER, json: { rules: [] } })).status).toBe(403);

    const saved = await policyForm(env, asForm(OPS_LEAD, "/app/policy"), form({ rules }));
    expect(saved).toMatchObject({ ok: true, version: expect.any(Number), moved: { toAutopilot: expect.any(Number), toPlanner: expect.any(Number) } });
    const put = await call("/api/policy", { method: "PUT", as: OPS_LEAD, json: { rules: JSON.parse(rules) } });
    expect(await put.json()).toMatchObject({ version: expect.any(Number), rules: JSON.parse(rules), moved: { toAutopilot: 0, toPlanner: 0 } });
  });
});

describe("triage dismiss", () => {
  async function notice(status: string) {
    const id = uid("n");
    await env.DB.prepare(
      `INSERT INTO notices (id, r2_key, filename, content_type, status, error, created_by, created_at) VALUES (?, 'k', 'bad.txt', 'text/plain', ?, 'no lots found', ?, ?)`,
    )
      .bind(id, status, PLANNER, Date.now() + 60_000)
      .run();
    return id;
  }

  it("planner or ops lead dismisses needs_triage and failed notices, with a reason; it leaves the board and the needs-me count", async () => {
    const triage = await notice("needs_triage");
    const failed = await notice("failed");
    const reading = await notice("processing");

    const board = await loadBoard(env);
    const stage = (id: string) => board.notices.find((n) => n.id === id)?.stage;
    expect([stage(triage), stage(failed), stage(reading)]).toEqual(["triage", "triage", "reading"]);
    const plannerCount = await countNeedsMe(env, "planner");
    const pharmacistCount = await countNeedsMe(env, "pharmacist");

    expect(await dismissNotice(env, pharmacist, { noticeId: triage, reason: "duplicate" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await dismissNotice(env, planner, { noticeId: triage, reason: "" })).toMatchObject({ ok: false, code: "invalid", fieldErrors: { reason: expect.any(Array) } });
    expect(await dismissNotice(env, planner, { noticeId: triage, reason: "x".repeat(201) })).toMatchObject({ ok: false, code: "invalid" });
    expect(await dismissNotice(env, planner, { noticeId: "n_nosuch", reason: "duplicate" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await dismissNotice(env, planner, { noticeId: "../etc", reason: "duplicate" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await dismissNotice(env, planner, { noticeId: reading, reason: "duplicate" })).toMatchObject({ ok: false, code: "conflict" });

    expect(await dismissNotice(env, planner, { noticeId: triage, reason: "  Duplicate of last week's notice  " })).toEqual({ ok: true, noticeId: triage, replay: false });
    expect(await dismissNotice(env, opsLead, { noticeId: failed, reason: "Not an allocation notice" })).toMatchObject({ ok: true, replay: false });
    expect(await dismissNotice(env, planner, { noticeId: triage, reason: "again" })).toEqual({ ok: true, noticeId: triage, replay: true });

    expect(await env.DB.prepare(`SELECT status, dismissed_reason, dismissed_by FROM notices WHERE id = ?`).bind(triage).first()).toEqual({
      status: "dismissed",
      dismissed_reason: "Duplicate of last week's notice",
      dismissed_by: PLANNER,
    });
    const rows = (await env.DB.prepare(`SELECT id, action, actor FROM audit_log WHERE entity = 'notice' AND entity_id = ? AND action = 'notice.dismissed'`).bind(triage).all()).results;
    expect(rows).toEqual([{ id: `notice:${triage}:dismissed`, action: "notice.dismissed", actor: PLANNER }]);

    const ids = (await loadBoard(env)).notices.map((n) => n.id);
    expect(ids).not.toContain(triage);
    expect(ids).not.toContain(failed);
    expect(ids).toContain(reading);
    expect(await countNeedsMe(env, "planner")).toBe(plannerCount - 2);
    expect(await countNeedsMe(env, "pharmacist")).toBe(pharmacistCount);
  });

  it("is exposed as a Server Action core and POST /api/notices/:id/dismiss", async () => {
    const a = await notice("needs_triage");
    const b = await notice("needs_triage");
    expect(await dismissNoticeForm(env, asForm(PLANNER, "/app"), form({ noticeId: a, reason: "spam" }))).toMatchObject({ ok: true, noticeId: a });
    expect(await dismissNoticeForm(env, asForm(PHARMACIST, "/app"), form({ noticeId: b, reason: "spam" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect((await call(`/api/notices/${b}/dismiss`, { method: "POST", as: PLANNER, json: {} })).status).toBe(400);
    const ok = await call(`/api/notices/${b}/dismiss`, { method: "POST", as: OPS_LEAD, json: { reason: "spam" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, noticeId: b, replay: false });
    const ready = await notice("ready");
    expect((await call(`/api/notices/${ready}/dismiss`, { method: "POST", as: PLANNER, json: { reason: "spam" } })).status).toBe(409);
  });
});
