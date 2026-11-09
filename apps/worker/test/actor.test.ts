import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { demoCookieValue, resolveUser, withActor } from "../src/lib/auth";
import { OPS_LEAD, PHARMACIST, PLANNER } from "./helpers";

const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new Request(`https://shortstop.test${path}`, { method, headers });

describe("resolveUser", () => {
  it("accepts the demo_user cookie for a demo persona", async () => {
    expect(await resolveUser(env, req("/api/me", { cookie: `theme=dark; demo_user=${encodeURIComponent(PLANNER)}` }))).toMatchObject({
      ok: true,
      user: { email: PLANNER, role: "planner" },
    });
  });

  it("refuses a cookie naming a real (non-demo) account", async () => {
    expect(await resolveUser(env, req("/api/me", { cookie: "demo_user=pronoy.pant@newpage.io" }))).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("reads x-demo-user, and ?as= only on GET file/export links", async () => {
    expect(await resolveUser(env, req("/api/me", { "x-demo-user": PHARMACIST }))).toMatchObject({ ok: true, user: { role: "pharmacist" } });
    expect(await resolveUser(env, req(`/api/me?as=${PLANNER}`))).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await resolveUser(env, req(`/api/export/allocations.csv?as=${PLANNER}`))).toMatchObject({ ok: true });
    expect(await resolveUser(env, req(`/api/export/allocations.csv?as=${PLANNER}`, {}, "POST"))).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("refuses an unknown demo persona", async () => {
    expect(await resolveUser(env, req("/api/me", { "x-demo-user": "ghost@shortstop.demo" }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("resolveUser with Turnstile on", () => {
  const on = { ...env, TURNSTILE_SITEKEY: "0x-site", TURNSTILE_SECRET: "test-turnstile-secret" } as Env;
  const cookie = (v: string) => ({ cookie: `demo_user=${encodeURIComponent(v)}` });

  it("accepts only the signed cookie that sign-in hands out", async () => {
    const signed = await demoCookieValue(on, PLANNER);
    expect(signed).not.toBe(PLANNER);
    expect(await resolveUser(on, req("/api/me", cookie(signed)))).toMatchObject({ ok: true, user: { email: PLANNER } });
  });

  it("refuses a hand-written cookie, a forged signature and a signature made for another persona", async () => {
    const forPlanner = await demoCookieValue(on, PLANNER);
    const forgedPharmacist = `${PHARMACIST}.${forPlanner.slice(forPlanner.lastIndexOf(".") + 1)}`;
    for (const value of [PLANNER, `${PLANNER}.deadbeef`, forgedPharmacist, `${PLANNER}.`, "no-dot"])
      expect(await resolveUser(on, req("/api/me", cookie(value)))).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("ignores x-demo-user and ?as=, which would skip the bot check", async () => {
    expect(await resolveUser(on, req("/api/me", { "x-demo-user": PHARMACIST }))).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await resolveUser(on, req(`/api/export/allocations.csv?as=${PLANNER}`))).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("lets nobody in when the site key has no secret to verify with", async () => {
    const misconfigured = { ...env, TURNSTILE_SITEKEY: "0x-site" } as Env;
    expect(await resolveUser(misconfigured, req("/api/me", { "x-demo-user": PLANNER, ...cookie(PLANNER) }))).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});

describe("withActor", () => {
  const action = withActor("test.action", ["planner", "ops_lead"], async (_env, actor, input: { n: number }) => ({ ok: true as const, by: actor.email, n: input.n }));

  it("runs the function with the resolved user as actor", async () => {
    expect(await action(env, req("/app", { cookie: `demo_user=${OPS_LEAD}` }, "POST"), { n: 1 })).toEqual({ ok: true, by: OPS_LEAD, n: 1 });
  });

  it("refuses a signed-out caller and the wrong role", async () => {
    expect(await action(env, req("/app", {}, "POST"), { n: 1 })).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await action(env, req("/app", { cookie: `demo_user=${PHARMACIST}` }, "POST"), { n: 1 })).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "requires role: planner or ops_lead",
    });
  });

  it("refuses once WRITE_LIMITER says no, keyed by the actor's email", async () => {
    const keys: string[] = [];
    const limited = { ...env, WRITE_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } } as unknown as Env;
    expect(await action(limited, req("/app", { cookie: `demo_user=${PLANNER}` }, "POST"), { n: 1 })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(keys).toEqual([PLANNER]);
  });

  it("names the refused action in the [RATELIMIT] line, not the request path", async () => {
    const limited = { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as Env;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await action(limited, req("/app", { cookie: `demo_user=${PLANNER}` }, "POST"), { n: 1 });
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[RATELIMIT]"));
      expect(JSON.parse(line!.slice("[RATELIMIT] ".length))).toMatchObject({ actor: PLANNER, action: "test.action" });
    } finally {
      log.mockRestore();
    }
  });
});
