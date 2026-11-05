import type { Role } from "@shortstop/shared";
import { DEMO_DOMAIN, isDemoIdentity, type User } from "../lib/auth";
import { fail, type Result } from "./result";

/** Demo sign-in is on only while Cloudflare Access is not configured and DEMO_AUTH is "true". */
export const demoAuthOn = (env: Env) => !env.ACCESS_AUD && env.DEMO_AUTH === "true";

/** The seeded demo personas, for the sign-in page and the persona switcher. Empty when demo sign-in is off. */
export async function listDemoUsers(env: Env): Promise<{ users: User[]; demo: boolean }> {
  if (!demoAuthOn(env)) return { users: [], demo: false };
  const { results } = await env.DB.prepare(`SELECT email, name, role FROM users WHERE email LIKE ? ORDER BY role, name`).bind(`%${DEMO_DOMAIN}`).all<User>();
  return { users: results, demo: true };
}

/**
 * Checks a demo sign-in: demo auth must be on, and the email must be a seeded @shortstop.demo persona. The transport
 * sets the `demo_user` cookie on success; `resolveUser` re-checks it on every request.
 */
export async function demoSignIn(env: Env, email: unknown): Promise<Result<{ user: User }>> {
  if (!demoAuthOn(env)) return fail("forbidden", "demo sign-in is off; sign in with Cloudflare Access");
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!isDemoIdentity(e)) return fail("forbidden", "demo sign-in only works for the demo personas");
  const user = await env.DB.prepare(`SELECT email, name, role FROM users WHERE email = ?`).bind(e).first<User>();
  return user ? { ok: true, user } : fail("forbidden", `${e} is not a ShortStop user`);
}

/**
 * How many lots on the board (the 25 newest notices, as `loadBoard`) wait on this role: pharmacists review
 * substitutes, everyone else acts on open lots. One COUNT, so the desk header can show it without loading the board.
 */
export async function countNeedsMe(env: Env, role: Role): Promise<number> {
  const status = role === "pharmacist" ? "needs_pharmacist" : "open";
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lots WHERE status = ? AND notice_id IN (SELECT id FROM notices ORDER BY created_at DESC LIMIT 25)`,
  )
    .bind(status)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
