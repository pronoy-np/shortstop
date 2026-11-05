import type { Role, UserView } from "@shortstop/shared";
import type { MiddlewareHandler } from "hono";
import { allowWrite } from "./ratelimit";
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

export const DEMO_COOKIE = "demo_user";

export type AuthFailCode = "unauthenticated" | "forbidden" | "rate_limited";
export type AuthFail = { ok: false; code: AuthFailCode; message: string };
export type Resolved = { ok: true; user: User } | AuthFail;

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Who is calling, from a plain Request (no transport framework), so the Hono API and Server Actions share one guard.
 * Cloudflare Access when ACCESS_AUD is configured (verifies the Access JWT).
 * Otherwise, only if DEMO_AUTH="true", a demo identity from the `demo_user` cookie, then the x-demo-user header, then
 * ?as= on WebSocket upgrades and GET file/export links (neither can set headers),
 * and only for the seeded @shortstop.demo personas, never a real person's account.
 * Either way the email must exist in the users table, which decides the role.
 */
export async function resolveUser(env: Env, req: Request): Promise<Resolved> {
  let email: string | null = null;
  if (env.ACCESS_AUD) {
    try {
      email = await emailFromAccess(env, env.ACCESS_AUD, req);
    } catch {
      return { ok: false, code: "unauthenticated", message: "invalid Access token" };
    }
  } else if (env.DEMO_AUTH === "true") {
    const url = new URL(req.url);
    // ?as= only where a header genuinely can't be sent: WebSocket upgrades and plain GET links to files and exports.
    const linkOrSocket = req.method === "GET" && (req.headers.get("Upgrade") === "websocket" || /^\/api\/(files|export\/)/.test(url.pathname));
    email = (cookie(req, DEMO_COOKIE) || req.headers.get("x-demo-user") || (linkOrSocket ? url.searchParams.get("as") : null) || "").toLowerCase() || null;
    if (email && !isDemoIdentity(email))
      return { ok: false, code: "forbidden", message: "demo sign-in only works for the demo personas; real accounts sign in with Cloudflare Access" };
  }
  if (!email) return { ok: false, code: "unauthenticated", message: "not signed in" };

  const user = await env.DB.prepare(`SELECT email, name, role FROM users WHERE email = ?`).bind(email).first<User>();
  if (!user) return { ok: false, code: "forbidden", message: `${email} is not a ShortStop user` };
  return { ok: true, user };
}

/** Hono adapter for `resolveUser`: 401 when nobody is signed in, 403 for an identity that may not use ShortStop. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await resolveUser(c.env, c.req.raw);
  if (!r.ok) return c.json({ error: r.message }, r.code === "unauthenticated" ? 401 : 403);
  c.set("user", r.user);
  await next();
};

/**
 * The Server Action guard, no weaker than the HTTP path: resolve the user, check the role, spend one write from the
 * actor's WRITE_LIMITER budget, then run `fn` with the user as actor. The service behind `fn` checks its own role floor too.
 */
export function withActor<I, R>(roles: readonly Role[], fn: (env: Env, actor: User, input: I) => Promise<R>) {
  return async (env: Env, req: Request, input: I): Promise<R | AuthFail> => {
    const r = await resolveUser(env, req);
    if (!r.ok) return r;
    if (!roles.includes(r.user.role)) return { ok: false, code: "forbidden", message: `requires role: ${roles.join(" or ")}` };
    if (!(await allowWrite(env, r.user.email, new URL(req.url).pathname)))
      return { ok: false, code: "rate_limited", message: "too many writes; slow down and retry in a minute" };
    return fn(env, r.user, input);
  };
}

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!roles.includes(c.get("user").role)) return c.json({ error: `requires role: ${roles.join(" or ")}` }, 403);
    await next();
  };
