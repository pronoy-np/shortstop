import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signInForm } from "../src/actions/forms";
import { DEMO_PROOF_COOKIE, PROOF_MAX_AGE_MS, TURNSTILE_FIELD, demoProof, siteverify, turnstileMode, verifyProof, type Verifier } from "../src/lib/turnstile";
import { PLANNER } from "./helpers";

// Turnstile on the public sign-in form (Cluster F2). siteverify is faked: these tests never call Cloudflare.

const SECRET = "test-turnstile-secret";
const on = { ...env, TURNSTILE_SITEKEY: "0x-site", TURNSTILE_SECRET: SECRET } as Env;

const req = (cookieEmail?: string, extra: { proof?: string; headers?: Record<string, string> } = {}, ip = "203.0.113.7") => {
  const cookies = [cookieEmail && `demo_user=${encodeURIComponent(cookieEmail)}`, extra.proof && `${DEMO_PROOF_COOKIE}=${extra.proof}`].filter(Boolean);
  return new Request("https://shortstop.test/sign-in", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, ...(cookies.length ? { cookie: cookies.join("; ") } : {}), ...extra.headers },
  });
};

const fields = (token?: string) => {
  const f = new FormData();
  f.set("email", PLANNER);
  if (token !== undefined) f.set(TURNSTILE_FIELD, token);
  return f;
};

/** A fake siteverify that records what it was asked and answers `pass`. */
function fakeVerify(pass: boolean) {
  const calls: { secret: string; token: string; ip: string | null }[] = [];
  const verify: Verifier = async (secret, token, ip) => {
    calls.push({ secret, token, ip });
    return pass;
  };
  return { verify, calls };
}

describe("Turnstile mode", () => {
  it("is on with a secret, off with neither, and misconfigured with only a site key", () => {
    expect(turnstileMode({ TURNSTILE_SECRET: "s", TURNSTILE_SITEKEY: "k" })).toBe("on");
    expect(turnstileMode({})).toBe("off");
    expect(turnstileMode({ TURNSTILE_SITEKEY: "k" })).toBe("misconfigured");
  });
});

describe("sign-in with Turnstile on", () => {
  it("refuses a submit with no token, without calling siteverify", async () => {
    const { verify, calls } = fakeVerify(true);
    expect(await signInForm(on, req(), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a forged token that siteverify rejects", async () => {
    const { verify, calls } = fakeVerify(false);
    expect(await signInForm(on, req(), fields("forged-token"), verify)).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toEqual([{ secret: SECRET, token: "forged-token", ip: "203.0.113.7" }]);
  });

  it("signs in when siteverify accepts the token", async () => {
    const { verify } = fakeVerify(true);
    expect(await signInForm(on, req(), fields("good-token"), verify)).toMatchObject({ ok: true, user: { email: PLANNER } });
  });

  it("refuses an oversized token", async () => {
    const { verify, calls } = fakeVerify(true);
    expect(await signInForm(on, req(), fields("x".repeat(2049)), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("lets a signed-in user switch persona without a token (the desk's switcher)", async () => {
    const { verify, calls } = fakeVerify(false);
    const proof = await demoProof(SECRET, "marcus@shortstop.demo");
    expect(await signInForm(on, req("marcus@shortstop.demo", { proof }), fields(), verify)).toMatchObject({ ok: true, user: { email: PLANNER } });
    expect(calls).toHaveLength(0);
  });

  it("issues a proof bound to the signed-in email after a passed check", async () => {
    const { verify } = fakeVerify(true);
    const r = await signInForm(on, req(), fields("good-token"), verify);
    expect(r).toMatchObject({ ok: true });
    const proof = (r as { proof?: string }).proof;
    expect(await verifyProof(SECRET, PLANNER, proof)).not.toBeNull();
    expect(await verifyProof(SECRET, "marcus@shortstop.demo", proof)).toBeNull();
  });

  it("keeps a proof's issue time across switches, so a replayed proof expires", async () => {
    const { verify, calls } = fakeVerify(false);
    const issuedAt = Date.now() - 1000;
    const r = await signInForm(on, req("marcus@shortstop.demo", { proof: await demoProof(SECRET, "marcus@shortstop.demo", issuedAt) }), fields(), verify);
    expect(await verifyProof(SECRET, PLANNER, (r as { proof?: string }).proof)).toBe(issuedAt);
    const stale = await demoProof(SECRET, "marcus@shortstop.demo", Date.now() - PROOF_MAX_AGE_MS - 1);
    expect(await signInForm(on, req("marcus@shortstop.demo", { proof: stale }), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("does not let a forged demo_user cookie or x-demo-user header skip the check", async () => {
    const { verify, calls } = fakeVerify(true);
    expect(await signInForm(on, req("marcus@shortstop.demo"), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(await signInForm(on, req(undefined, { headers: { "x-demo-user": "marcus@shortstop.demo" } }), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    // A proof for one persona does not vouch for another, and a proof made with another key is worthless.
    expect(await signInForm(on, req("marcus@shortstop.demo", { proof: await demoProof(SECRET, PLANNER) }), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(await signInForm(on, req("marcus@shortstop.demo", { proof: await demoProof("other-secret", "marcus@shortstop.demo") }), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("does not treat a non-demo cookie as signed in", async () => {
    const { verify } = fakeVerify(false);
    expect(await signInForm(on, req("pronoy.pant@newpage.io"), fields(), verify)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("refuses anonymous sign-in when the site key is set without its secret", async () => {
    const misconfigured = { ...env, TURNSTILE_SITEKEY: "0x-site" } as Env;
    const { verify, calls } = fakeVerify(true);
    expect(await signInForm(misconfigured, req(), fields("good-token"), verify)).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("is skipped entirely when Turnstile is off", async () => {
    const { verify, calls } = fakeVerify(false);
    expect(await signInForm(env, req(), fields(), verify)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(0);
  });
});

describe("siteverify", () => {
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the secret, token and IP to Cloudflare", async () => {
    let sent: FormData | null = null;
    let url = "";
    const fetcher = (async (u: string, init: RequestInit) => {
      url = u;
      sent = init.body as FormData;
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    expect(await siteverify(fetcher)(SECRET, "tok", "198.51.100.1")).toBe(true);
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect([sent!.get("secret"), sent!.get("response"), sent!.get("remoteip")]).toEqual([SECRET, "tok", "198.51.100.1"]);
  });

  it("fails closed on a rejection, a non-200, bad JSON or a network error", async () => {
    expect(await siteverify(respond({ success: false, "error-codes": ["invalid-input-response"] }))(SECRET, "t", null)).toBe(false);
    expect(await siteverify(respond({ success: true }, 500))(SECRET, "t", null)).toBe(false);
    expect(await siteverify(respond({ nope: 1 }))(SECRET, "t", null)).toBe(false);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await siteverify(down)(SECRET, "t", null)).toBe(false);
  });
});
