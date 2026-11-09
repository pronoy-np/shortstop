import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { allocationsFrom, commitForm, noticeForm, policyForm, reservationForm, signInForm, substituteForm } from "../src/actions/forms";
import { countNeedsMe } from "../src/services/users";
import { OPS_LEAD, PHARMACIST, PLANNER, PLANNER_2, lotRow, makeLot } from "./helpers";

// The Server Action cores, called the way app/_lib/actions.ts calls them: a plain Request (cookies as the browser sent
// them) and the submitted FormData. No Next.js runtime is involved.

const as = (email: string | null, path = "/app") =>
  new Request(`https://shortstop.test${path}`, { method: "POST", headers: email ? { cookie: `demo_user=${encodeURIComponent(email)}` } : {} });

const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const commitFields = (lotId: string, commitKey: string, qty: Record<string, number>) =>
  form({ lotId, commitKey, ...Object.fromEntries(Object.entries(qty).map(([site, q]) => [`qty:${site}`, String(q)])) });

describe("Server Action cores", () => {
  it("reads qty:<site> fields as allocations and skips blanks", () => {
    expect(allocationsFrom(form({ lotId: "x", "qty:rci": "5", "qty:sch": "", "qty:umc": "0" }))).toEqual([
      { siteId: "rci", quantity: 5 },
      { siteId: "umc", quantity: 0 },
    ]);
  });

  it("commits with the demo_user cookie, and a resubmitted form is a replay", async () => {
    const { lotId } = await makeLot({ quantity: 100 });
    const fields = commitFields(lotId, "form-key-1", { rci: 30 });
    expect(await commitForm(env, as(PLANNER), fields)).toEqual({ ok: true, available: 70, commitKey: "form-key-1" });
    expect(await commitForm(env, as(PLANNER), fields)).toMatchObject({ ok: true, available: 70 });
    expect((await lotRow(lotId))?.remaining).toBe(70);
  });

  it("refuses a signed-out caller, a non-demo cookie and the wrong role", async () => {
    const { lotId } = await makeLot();
    const fields = commitFields(lotId, "form-key-2", { rci: 1 });
    expect(await commitForm(env, as(null), fields)).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await commitForm(env, as("pronoy.pant@newpage.io"), fields)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await commitForm(env, as(PHARMACIST), fields)).toMatchObject({ ok: false, code: "forbidden", message: "requires role: planner or ops_lead" });
  });

  it("stops at the write limiter", async () => {
    const { lotId } = await makeLot();
    const limited = { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as Env;
    expect(await commitForm(limited, as(PLANNER), commitFields(lotId, "form-key-3", { rci: 1 }))).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("returns field errors for invalid input, and the rebased split when the race is lost", async () => {
    const { lotId } = await makeLot({ quantity: 50 });
    expect(await commitForm(env, as(PLANNER), commitFields(lotId, "auto:nope", { rci: 1 }))).toMatchObject({
      ok: false,
      code: "invalid",
      fieldErrors: { commitKey: ["commit keys may not start with auto:"] },
    });
    expect(await commitForm(env, as(PLANNER), commitFields(lotId, "race-key-a", { rci: 40 }))).toMatchObject({ ok: true, available: 10 });
    const lost = await commitForm(env, as(PLANNER_2), commitFields(lotId, "race-key-b", { rci: 40 }));
    expect(lost).toMatchObject({ ok: false, code: "conflict", available: 10, proposal: { allocations: expect.any(Array) } });
  });

  it("reservation, substitute, notice and policy forms go through the same services", async () => {
    const { lotId } = await makeLot();
    expect(await reservationForm(env, as(PLANNER), form({ lotId, mode: "cancel" }))).toMatchObject({ ok: false, code: "conflict" });

    const sub = await makeLot({ substitutePending: true });
    expect(await substituteForm(env, as(PLANNER), form({ lotId: sub.lotId, decision: "approved" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await substituteForm(env, as(PHARMACIST), form({ lotId: sub.lotId, decision: "approved" }))).toMatchObject({ ok: true });

    expect(await noticeForm(env, as(PLANNER, "/app/intake"), form({ text: "" }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await noticeForm(env, as(PLANNER, "/app/intake"), form({ text: "Cefazolin 1 g vial: 120 vials" }))).toMatchObject({
      ok: true,
      noticeId: expect.stringMatching(/^n_/),
    });

    expect(await policyForm(env, as(OPS_LEAD, "/app/policy"), form({ rules: "{not json" }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await policyForm(env, as(PLANNER, "/app/policy"), form({ rules: "[]" }))).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("demo sign-in accepts a seeded persona only", async () => {
    expect(await signInForm(env, as(null, "/sign-in"), form({ email: "PRIYA@shortstop.demo" }))).toMatchObject({ ok: true, user: { email: PLANNER, role: "planner" } });
    expect(await signInForm(env, as(null, "/sign-in"), form({ email: "ghost@shortstop.demo" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await signInForm(env, as(null, "/sign-in"), form({ email: "pronoy.pant@newpage.io" }))).toMatchObject({ ok: false, code: "forbidden" });
    const accessOn = { ...env, ACCESS_AUD: "aud" } as Env;
    expect(await signInForm(accessOn, as(null, "/sign-in"), form({ email: PLANNER }))).toMatchObject({ ok: false, message: expect.stringContaining("Access") });
  });

  it("counts the lots waiting on a role", async () => {
    const before = await countNeedsMe(env, "pharmacist");
    await makeLot({ substitutePending: true });
    expect(await countNeedsMe(env, "pharmacist")).toBe(before + 1);
  });
});

describe("demo persona list", () => {
  it("reads the seeded personas from D1 once per isolate, not once per render", async () => {
    const { listDemoUsers, resetDemoUsersCache } = await import("../src/services/users");
    resetDemoUsersCache();
    let prepares = 0;
    const counting = { ...env, DB: new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (...a: [string]) => (prepares++, t.prepare(...a)) : Reflect.get(t, k, t)) }) } as Env;
    const first = await listDemoUsers(counting);
    const second = await listDemoUsers(counting);
    expect(first.users.map((u) => u.email)).toContain(PLANNER);
    expect(second).toEqual(first);
    expect(prepares).toBe(1);
  });
});
