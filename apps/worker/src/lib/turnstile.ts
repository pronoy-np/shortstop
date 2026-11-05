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
