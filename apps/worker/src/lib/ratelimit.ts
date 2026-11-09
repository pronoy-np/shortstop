import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

/**
 * Per-actor write throttle (the WRITE_LIMITER binding: 30 requests / 60 s, see wrangler.jsonc).
 * The key is the signed-in email, not the IP: behind Access every user shares edge IPs.
 * A missing binding or a limiter error fails open: this guards against abuse, and the Durable Object still serializes
 * every write. Returns true when the write may go ahead. `action` names the write for the log: an API route
 * ("POST /api/lots/:id/commit") or a Server Action ("lot.commit").
 */
export async function allowWrite(env: Env, actor: string, action: string): Promise<boolean> {
  if (!env.WRITE_LIMITER) return true;
  const verdict = await env.WRITE_LIMITER.limit({ key: actor }).catch(() => ({ success: true }));
  if (!verdict.success) console.log(`[RATELIMIT] ${JSON.stringify({ ts: new Date().toISOString(), actor, action })}`);
  return verdict.success;
}

/** Hono adapter: runs after `authenticate`. Reads are not limited here (see `limitCostlyReads` for the two that cost something). */
export const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (!(await allowWrite(c.env, c.get("user").email, `${c.req.method} ${new URL(c.req.url).pathname}`)))
    return c.json({ error: "too many writes; slow down and retry in a minute" }, 429, { "Retry-After": "60" });
  return next();
};

/**
 * Reads are free except two that cost something real: `/api/search` spends Workers AI neurons on every call, and the CSV
 * export scans the allocations table and writes an audit row. They get their own bucket (same limit, key `<email>:read`)
 * so heavy searching can never block someone from committing.
 */
export const limitCostlyReads: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await allowWrite(c.env, `${c.get("user").email}:read`, `${c.req.method} ${new URL(c.req.url).pathname}`)))
    return c.json({ error: "too many requests; slow down and retry in a minute" }, 429, { "Retry-After": "60" });
  return next();
};
