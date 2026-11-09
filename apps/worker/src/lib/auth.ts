import type { Role, UserView } from "@shortstop/shared";
import type { MiddlewareHandler } from "hono";
import { allowWrite } from "./ratelimit";
import { toHex } from "./hex";
import { turnstileMode } from "./turnstile";
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

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`shortstop-demo-cookie:${message}`)));
}

/** Constant-time compare of two hex strings. */
const sameHex = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

/**
 * What goes in the `demo_user` cookie. Once Turnstile guards sign-in, the email is signed (`email.hmac`, keyed by
 * TURNSTILE_SECRET) so nobody can skip the bot check by writing the cookie by hand. Without Turnstile (local dev,
 * tests) it stays the plain email.
 */
export async function demoCookieValue(env: Env, email: string): Promise<string> {
  return turnstileMode(env) === "on" ? `${email}.${await hmac(env.TURNSTILE_SECRET!, email)}` : email;
}

/** The email inside a `demo_user` cookie value, or null when Turnstile is on and the signature does not match. */
export async function demoCookieEmail(env: Env, value: string): Promise<string | null> {
  const mode = turnstileMode(env);
  if (mode === "off") return value;
  if (mode === "misconfigured") return null; // no secret to verify with: fail closed
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const email = value.slice(0, dot);
  return sameHex(value.slice(dot + 1), await hmac(env.TURNSTILE_SECRET!, email)) ? email : null;
}

export type AuthFailCode = "unauthenticated" | "forbidden" | "rate_limited";
export type AuthFail = { ok: false; code: AuthFailCode; message: string };
export type Resolved = { ok: true; user: User } | AuthFail;

export function cookie(req: Request, name: string): string | undefined {
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
 * With Turnstile on, only the signed cookie counts: the header and ?as= would let a script skip the bot check.
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
    const stored = cookie(req, DEMO_COOKIE);
    if (turnstileMode(env) === "off") {
      // ?as= only where a header genuinely can't be sent: WebSocket upgrades and plain GET links to files and exports.
      const linkOrSocket = req.method === "GET" && (req.headers.get("Upgrade") === "websocket" || /^\/api\/(files|export\/)/.test(url.pathname));
      email = (stored || req.headers.get("x-demo-user") || (linkOrSocket ? url.searchParams.get("as") : null) || "").toLowerCase() || null;
    } else {
      // Turnstile guards sign-in, so the only way in is the signed cookie it hands out: the header and ?as= would skip the check.
      email = ((stored && (await demoCookieEmail(env, stored))) || "").toLowerCase() || null;
    }
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
 * actor's WRITE_LIMITER budget (logged under `action` when refused), then run `fn` with the user as actor. The service behind `fn` checks its own role floor too.
 */
export function withActor<I, R>(action: string, roles: readonly Role[], fn: (env: Env, actor: User, input: I) => Promise<R>) {
  return async (env: Env, req: Request, input: I): Promise<R | AuthFail> => {
    const r = await resolveUser(env, req);
    if (!r.ok) return r;
    if (!roles.includes(r.user.role)) return { ok: false, code: "forbidden", message: `requires role: ${roles.join(" or ")}` };
    // The action name, not the request path: every Server Action posts to whatever page it was invoked from.
    if (!(await allowWrite(env, r.user.email, action)))
      return { ok: false, code: "rate_limited", message: "too many writes; slow down and retry in a minute" };
    return fn(env, r.user, input);
  };
}
