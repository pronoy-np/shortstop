import type { Role, UserView } from "@shortstop/shared";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type User = UserView;
export type AppEnv = { Bindings: Env; Variables: { user: User } };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Demo identities are limited to the seeded demo personas; real accounts only ever sign in through Access. */
export const DEMO_DOMAIN = "@shortstop.demo";
export const isDemoIdentity = (email: string) => email.endsWith(DEMO_DOMAIN);

/**
 * Verifies a Cloudflare Access JWT (signature, issuer, audience, expiry) and returns its email, lower-cased.
 * Throws on any invalid token. The key set is a parameter so tests can sign their own tokens.
 */
export async function verifyAccessJwt(token: string, opts: { issuer: string; audience: string; keys: JWTVerifyGetKey }): Promise<string | null> {
  const { payload } = await jwtVerify(token, opts.keys, { issuer: opts.issuer, audience: opts.audience });
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}

async function emailFromAccess(env: Env, audience: string, req: Request): Promise<string | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return verifyAccessJwt(token, { issuer, audience, keys: jwks });
}

/**
 * Cloudflare Access when ACCESS_AUD is configured (verifies the Access JWT).
 * Otherwise, only if DEMO_AUTH="true", a demo identity from the x-demo-user header, or ?as= on WebSocket upgrades and
 * file/export links (neither can set headers),
 * and only for the seeded @shortstop.demo personas, never a real person's account.
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
    // ?as= only where a header genuinely can't be sent: WebSocket upgrades and plain GET links to files and exports.
    const linkOrSocket =
      c.req.method === "GET" && (c.req.header("Upgrade") === "websocket" || /^\/api\/(files|export\/)/.test(c.req.path));
    email = (c.req.header("x-demo-user") ?? (linkOrSocket ? c.req.query("as") : undefined) ?? "").toLowerCase() || null;
    if (email && !isDemoIdentity(email)) return c.json({ error: "demo sign-in only works for the demo personas; real accounts sign in with Cloudflare Access" }, 403);
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
