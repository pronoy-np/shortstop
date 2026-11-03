import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OPS_LEAD, PHARMACIST, PLANNER, PLANNER_2, call, lotRow, makeLot } from "./helpers";

describe("auth", () => {
  it("health is public, everything else needs a known user", async () => {
    expect((await call("/api/health")).status).toBe(200);
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { as: "stranger@example.com" })).status).toBe(403);
    expect(await (await call("/api/me", { as: PLANNER })).json()).toMatchObject({ role: "planner" });
  });

  it("lists demo users for the identity switcher", async () => {
    const body = await (await call("/api/users")).json<{ demo: boolean; users: unknown[] }>();
    expect(body.demo).toBe(true);
    expect(body.users.length).toBeGreaterThanOrEqual(4);
  });
});

describe("commit", () => {
  it("first planner commits, second gets a 409 with a rebased proposal for what is left", async () => {
    const { lotId } = await makeLot({ drugId: "cisplatin", quantity: 500 });
    const first = await call(`/api/lots/${lotId}/commit`, {
      method: "POST",
      as: PLANNER,
      json: { commitKey: "commit-first-1", allocations: [{ siteId: "rci", quantity: 360 }] },
    });
    expect(first.status).toBe(200);

    const second = await call(`/api/lots/${lotId}/commit`, {
      method: "POST",
      as: PLANNER_2,
      json: { commitKey: "commit-second", allocations: [{ siteId: "rumc", quantity: 300 }, { siteId: "rci", quantity: 200 }] },
    });
    expect(second.status).toBe(409);
    const body = await second.json<{ available: number; proposal: { allocations: { quantity: number }[] } }>();
    expect(body.available).toBe(140);
    expect(body.proposal.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(140);
  });

  it("only planners and the ops lead can commit", async () => {
    const { lotId } = await makeLot();
    const res = await call(`/api/lots/${lotId}/commit`, {
      method: "POST",
      as: PHARMACIST,
      json: { commitKey: "commit-pharm", allocations: [{ siteId: "rci", quantity: 1 }] },
    });
    expect(res.status).toBe(403);
  });

  it("validates the body and sites", async () => {
    const { lotId } = await makeLot();
    const bad = (json: unknown) => call(`/api/lots/${lotId}/commit`, { method: "POST", as: PLANNER, json });
    expect((await bad({ commitKey: "x", allocations: [] })).status).toBe(400);
    expect((await bad({ commitKey: "commit-unknown", allocations: [{ siteId: "nowhere", quantity: 5 }] })).status).toBe(400);
    expect((await bad({ commitKey: "commit-neg", allocations: [{ siteId: "rci", quantity: -5 }] })).status).toBe(400);
    expect((await call(`/api/lots/nope/commit`, { method: "POST", as: PLANNER, json: { commitKey: "commit-404", allocations: [{ siteId: "rci", quantity: 1 }] } })).status).toBe(404);
  });

  it("hard floor: a pending substitute blocks commits until a pharmacist reviews it", async () => {
    const { lotId } = await makeLot({ substitutePending: true });
    const commit = () =>
      call(`/api/lots/${lotId}/commit`, { method: "POST", as: PLANNER, json: { commitKey: `commit-${lotId}`, allocations: [{ siteId: "rci", quantity: 10 }] } });
    expect((await commit()).status).toBe(409);

    expect((await call(`/api/lots/${lotId}/substitute`, { method: "POST", as: PLANNER, json: { decision: "approved" } })).status).toBe(403);
    expect((await call(`/api/lots/${lotId}/substitute`, { method: "POST", as: PHARMACIST, json: { decision: "approved" } })).status).toBe(200);
    expect(await lotRow(lotId)).toMatchObject({ status: "open", substitute_status: "approved" });
    expect((await call(`/api/lots/${lotId}/substitute`, { method: "POST", as: PHARMACIST, json: { decision: "rejected" } })).status).toBe(409);
    // The refused second decision left no audit trace.
    const audits = await env.DB.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action LIKE 'lot.substitute_%'`).bind(lotId).all<{ action: string }>();
    expect(audits.results.map((a) => a.action)).toEqual(["lot.substitute_approved"]);

    expect((await commit()).status).toBe(200);
  });

  it("planners can cancel or take over a pending auto-commit", async () => {
    const { lotId, stub } = await makeLot({ drugId: "ondansetron", quantity: 100 });
    await stub.reserveAuto({ commitKey: `auto:${lotId}`, allocations: [{ siteId: "rci", quantity: 100 }], ruleId: "x", policyVersion: 1, windowMs: 60_000 });
    expect((await call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "cancel" } })).status).toBe(400);
    const res = await call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "takeover", key: "takeover-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allocations: [{ siteId: "rci", quantity: 100 }] });
    expect((await call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "cancel", key: "cancel-2-xx" } })).status).toBe(409);
  });
});

describe("policy", () => {
  const rules = [
    { id: "glp1-manual", when: { drugClass: "glp1" }, then: "manual_only" },
    { id: "tiny-auto", when: { maxLotQty: 50 }, then: "auto_commit" },
  ];

  it("only the ops lead can save, and every save is a new immutable version", async () => {
    expect((await call("/api/policy", { method: "PUT", as: PLANNER, json: { rules } })).status).toBe(403);
    expect((await call("/api/policy", { method: "PUT", as: OPS_LEAD, json: { rules: [{ id: "BAD ID", when: {}, then: "x" }] } })).status).toBe(400);

    const saved = await (await call("/api/policy", { method: "PUT", as: OPS_LEAD, json: { rules } })).json<{ version: number }>();
    expect(saved.version).toBeGreaterThanOrEqual(2);
    const got = await (await call("/api/policy", { as: PLANNER })).json<{ current: { version: number; rules: unknown[] }; versions: { version: number }[] }>();
    expect(got.current).toEqual({ version: saved.version, rules });
    expect(got.versions.map((v) => v.version)).toContain(1);
    expect(await env.CACHE.get("policy:current", "json")).toEqual({ version: saved.version, rules });
  });
});

describe("read endpoints", () => {
  it("board, audit, metrics and export respond", async () => {
    await makeLot();
    const board = await (await call("/api/board", { as: PLANNER })).json<{ notices: { lots: unknown[] }[]; sites: unknown[] }>();
    expect(board.sites).toHaveLength(10);
    expect(board.notices.length).toBeGreaterThan(0);
    expect((await call("/api/audit?limit=5", { as: PLANNER })).status).toBe(200);
    expect((await call("/api/audit?limit=abc", { as: PLANNER })).status).toBe(400);
    expect((await call("/api/audit?limit=9999", { as: PLANNER })).status).toBe(400);
    const metrics = await (await call("/api/metrics", { as: OPS_LEAD })).json<{ cover: { lowest: unknown[] } }>();
    expect(metrics.cover.lowest.length).toBeGreaterThan(0);
    const csv = await call("/api/export/allocations.csv", { as: OPS_LEAD });
    expect(csv.headers.get("content-type")).toBe("text/csv");
  });

  it("file access is restricted to stored notices and confirmations", async () => {
    expect((await call("/api/files?key=../../etc/passwd", { as: PLANNER })).status).toBe(400);
    expect((await call("/api/files?key=secrets/x/y", { as: PLANNER })).status).toBe(400);
    expect((await call("/api/files?key=notices/nope/none.txt", { as: PLANNER })).status).toBe(404);
  });

  it("intake rejects empty submissions and planners only", async () => {
    const empty = new FormData();
    expect((await call("/api/notices", { method: "POST", as: PLANNER, body: empty })).status).toBe(400);
    const form = new FormData();
    form.set("text", "Allocation: ondansetron 200 vials");
    expect((await call("/api/notices", { method: "POST", as: PHARMACIST, body: form })).status).toBe(403);
  });
});
