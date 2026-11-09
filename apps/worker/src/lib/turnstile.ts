import { z } from "zod";
import { toHex } from "./hex";

/**
 * Cloudflare Turnstile on the public sign-in form (Cluster F2). The widget puts a one-time token in the form; the
 * Server Action core checks it with siteverify before setting the demo cookie.
 *
 * - `on`: TURNSTILE_SECRET is set, so anonymous sign-ins need a token that siteverify accepts.
 * - `off`: neither TURNSTILE_SECRET nor TURNSTILE_SITEKEY is set (local dev, `pnpm test`, `pnpm test:e2e`).
 * - `misconfigured`: a site key without its secret. The widget would render but nothing could check it, so
 *   sign-in is refused rather than silently unprotected.
 */
export type TurnstileMode = "on" | "off" | "misconfigured";

export const TURNSTILE_FIELD = "cf-turnstile-response";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Proof that this browser passed the check for `email`: `<issuedAt>.<HMAC-SHA-256 of email and issuedAt under
 * TURNSTILE_SECRET>`, set as its own httpOnly cookie next to `demo_user` on each sign-in. The `demo_user` cookie and the
 * `x-demo-user` header are plain values anyone can send, so only this proof lets a returning caller (the desk's persona
 * switcher) skip the widget. A switch re-issues the proof for the new email with the original `issuedAt`, so one solved
 * check is good for at most PROOF_MAX_AGE_MS, however often it is replayed. Rotating TURNSTILE_SECRET invalidates every proof.
 */
export const DEMO_PROOF_COOKIE = "demo_proof";
/** Matches the demo cookie's 30-day lifetime. */
export const PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const proofKey = (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const proofData = (email: string, issuedAt: number) => new TextEncoder().encode(`shortstop-demo-proof:${email}:${issuedAt}`);

export async function demoProof(secret: string, email: string, issuedAt = Date.now()): Promise<string> {
  return `${issuedAt}.${toHex(await crypto.subtle.sign("HMAC", await proofKey(secret), proofData(email, issuedAt)))}`;
}

/** The proof's issue time when it vouches for `email` and has not expired, else null. The MAC check is constant-time. */
export async function verifyProof(secret: string, email: string, proof: string | undefined, now = Date.now()): Promise<number | null> {
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(proof ?? "");
  if (!m) return null;
  const issuedAt = Number(m[1]);
  if (issuedAt > now || now - issuedAt > PROOF_MAX_AGE_MS) return null;
  const mac = new Uint8Array(m[2]!.match(/../g)!.map((h) => parseInt(h, 16)));
  return (await crypto.subtle.verify("HMAC", await proofKey(secret), mac, proofData(email, issuedAt))) ? issuedAt : null;
}

export function turnstileMode(env: Pick<Env, "TURNSTILE_SECRET" | "TURNSTILE_SITEKEY">): TurnstileMode {
  if (env.TURNSTILE_SECRET) return "on";
  return env.TURNSTILE_SITEKEY ? "misconfigured" : "off";
}

const SiteverifyResponse = z.object({ success: z.boolean(), "error-codes": z.array(z.string()).optional() });

/** Checks a widget token. Anything but an explicit `success: true` (network error, bad JSON, non-200) is a no. */
export type Verifier = (secret: string, token: string, remoteIp: string | null) => Promise<boolean>;

export const siteverify =
  (fetcher: typeof fetch = fetch): Verifier =>
  async (secret, token, remoteIp) => {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);
    try {
      const res = await fetcher(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const parsed = SiteverifyResponse.safeParse(await res.json());
      if (!parsed.success) return false;
      if (!parsed.data.success) console.log(`[TURNSTILE] ${JSON.stringify({ ts: new Date().toISOString(), outcome: "rejected", errors: parsed.data["error-codes"] ?? [] })}`);
      return parsed.data.success;
    } catch {
      return false;
    }
  };
