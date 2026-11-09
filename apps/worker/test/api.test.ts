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

  it("lists only the demo personas for the identity switcher", async () => {
    const body = await (await call("/api/users")).json<{ demo: boolean; users: { email: string }[] }>();
    expect(body.demo).toBe(true);
    expect(body.users.length).toBe(4);
    expect(body.users.every((u) => u.email.endsWith("@shortstop.demo"))).toBe(true);
  });

  it("demo sign-in cannot impersonate a real account (those need Cloudflare Access)", async () => {
    expect((await call("/api/me", { as: "pronoy.pant@newpage.io" })).status).toBe(403);
    expect((await call("/api/files?key=notices/x/y.txt&as=pronoy.pant@newpage.io")).status).toBe(403);
  });

  it("?as= is only honoured on links and sockets, never on API calls", async () => {
    expect((await call("/api/me?as=priya@shortstop.demo")).status).toBe(401);
    expect((await call("/api/board?as=priya@shortstop.demo")).status).toBe(401);
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

  it("planners can cancel or take over a pending auto-commit; the server derives the key so retries are replays", async () => {
    const { lotId, stub } = await makeLot({ drugId: "ondansetron", quantity: 100 });
    await stub.reserveAuto({ commitKey: `auto:${lotId}`, allocations: [{ siteId: "rci", quantity: 100 }], ruleId: "x", policyVersion: 1, windowMs: 60_000 });
    const takeover = () => call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "takeover" } });
    const first = await takeover();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ allocations: [{ siteId: "rci", quantity: 100 }], replay: false });
    // A double click or network retry, with no key from the client: the same take-over, not a second one.
    expect(await (await takeover()).json()).toMatchObject({ ok: true, replay: true });
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'lot.taken_over'`).bind(lotId).first<{ n: number }>();
    expect(audits?.n).toBe(1);
    // Nothing reserved and no earlier cancel of that kind: there is nothing to cancel.
    expect((await call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "cancel" } })).status).toBe(409);
    expect((await call(`/api/lots/${lotId}/reservation`, { method: "POST", as: PLANNER, json: { mode: "pause" } })).status).toBe(400);
  });
});

describe("policy", () => {
  const rules = [
    { id: "glp1-manual", when: { drugClass: "glp1" }, then: "manual_only" },
    { id: "tiny-auto", when: { maxLotQty: 50, needsSubstitute: false }, then: "auto_commit" },
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

describe("write rate limit", () => {
  it("answers 429 once an actor passes 30 writes a minute, and never limits reads", async () => {
    // Bad body: the limiter runs before validation, so each hit is cheap and writes nothing. Earlier tests in this
    // file already spent part of the budget, so assert on the first 429 rather than a fixed count.
    const hit = async () => (await call("/api/lots/n_x-1/commit", { method: "POST", as: PHARMACIST, json: {} })).status;
    let attempts = 0;
    while ((await hit()) !== 429) {
      attempts++;
      expect(attempts).toBeLessThanOrEqual(30);
    }
    expect(await hit()).toBe(429);
    expect((await call("/api/board", { as: PHARMACIST })).status).toBe(200);
    // Another actor has their own budget.
    expect((await call("/api/lots/n_x-1/commit", { method: "POST", as: OPS_LEAD, json: {} })).status).not.toBe(429);
  });
});

describe("costly read rate limit", () => {
  it("search and export share a separate read bucket: 429 for them, while the same actor can still write and read the board", async () => {
    // A too-short query is rejected after the limiter runs, so each hit is cheap and spends no AI.
    const hit = async () => (await call("/api/search?q=x", { as: PLANNER_2 })).status;
    let attempts = 0;
    while ((await hit()) !== 429) {
      attempts++;
      expect(attempts).toBeLessThanOrEqual(30);
    }
    const limited = await call("/api/export/allocations.csv", { as: PLANNER_2 });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await call("/api/board", { as: PLANNER_2 })).status).toBe(200);
    expect((await call("/api/lots/n_x-1/commit", { method: "POST", as: PLANNER_2, json: {} })).status).not.toBe(429);
    // Another actor has their own read budget.
    expect((await call("/api/search?q=x", { as: PHARMACIST })).status).toBe(400);
  });
});
