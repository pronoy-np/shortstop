import { z } from "zod";

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
 * Proof that this browser passed the check for `email`: HMAC-SHA-256 of the email under TURNSTILE_SECRET, set as its own
 * httpOnly cookie next to `demo_user` on each sign-in. The `demo_user` cookie and the `x-demo-user` header are plain
 * values anyone can send, so only this proof lets a returning caller (the desk's persona switcher) skip the widget.
 * Rotating TURNSTILE_SECRET invalidates every proof; those users pass the widget once more.
 */
export const DEMO_PROOF_COOKIE = "demo_proof";

export async function demoProof(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`shortstop-demo-proof:${email}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time check of a proof cookie against the email it claims to vouch for. */
export async function hasValidProof(secret: string, email: string, proof: string | undefined): Promise<boolean> {
  if (!proof) return false;
  const want = new TextEncoder().encode(await demoProof(secret, email));
  const got = new TextEncoder().encode(proof);
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i]! ^ got[i]!;
  return diff === 0;
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
