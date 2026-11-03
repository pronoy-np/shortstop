import type { Role } from "@shortstop/shared";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type User = { email: string; name: string; role: Role };
export type AppEnv = { Bindings: Env; Variables: { user: User } };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function emailFromAccess(env: Env, audience: string, req: Request): Promise<string | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}

/**
 * Cloudflare Access when ACCESS_AUD is configured (verifies the Access JWT).
 * Otherwise, only if DEMO_AUTH="true", a demo identity from the x-demo-user header or ?as= (WebSockets can't set headers).
 * Either way the email must exist in the users table, which decides the role.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  let email: string | null = null;
  if (c.env.ACCESS_AUD) {
    try {
      email = await emailFromAccess(c.env, c.env.ACCESS_AUD, c.req.raw);
    } catch {
      return c.json({ error: "invalid Access token" }, 401);
    }
  } else if (c.env.DEMO_AUTH === "true") {
    email = (c.req.header("x-demo-user") ?? c.req.query("as") ?? "").toLowerCase() || null;
  }
  if (!email) return c.json({ error: "not signed in" }, 401);

  const user = await c.env.DB.prepare(`SELECT email, name, role FROM users WHERE email = ?`).bind(email).first<User>();
  if (!user) return c.json({ error: `${email} is not a ShortStop user` }, 403);
  c.set("user", user);
  await next();
};

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!roles.includes(c.get("user").role)) return c.json({ error: `requires role: ${roles.join(" or ")}` }, 403);
    await next();
  };
