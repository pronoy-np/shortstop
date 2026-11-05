import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

/**
 * Per-actor write throttle (the WRITE_LIMITER binding: 30 requests / 60 s, see wrangler.jsonc).
 * Runs after `authenticate`, so the key is the signed-in email, not the IP: behind Access every user shares edge IPs.
 * Reads are never limited. A missing binding or a limiter error fails open: this guards against abuse,
 * and the Durable Object still serializes every write.
 */
export const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || !c.env.WRITE_LIMITER) return next();
  const actor = c.get("user").email;
  const verdict = await c.env.WRITE_LIMITER.limit({ key: actor }).catch(() => ({ success: true }));
  if (!verdict.success) {
    console.log(`[RATELIMIT] ${JSON.stringify({ ts: new Date().toISOString(), actor, path: new URL(c.req.url).pathname })}`);
    return c.json({ error: "too many writes; slow down and retry in a minute" }, 429, { "Retry-After": "60" });
  }
  return next();
};
