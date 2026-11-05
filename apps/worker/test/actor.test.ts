import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveUser, withActor } from "../src/lib/auth";
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

describe("withActor", () => {
  const action = withActor(["planner", "ops_lead"], async (_env, actor, input: { n: number }) => ({ ok: true as const, by: actor.email, n: input.n }));

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
});
