import type { Role } from "@shortstop/shared";
import { DEMO_DOMAIN, isDemoIdentity, type User } from "../lib/auth";
import { BOARD_NOTICE_IDS_SQL } from "./board";
import { fail, type Result } from "./result";

/** Demo sign-in is on only while Cloudflare Access is not configured and DEMO_AUTH is "true". */
export const demoAuthOn = (env: Env) => !env.ACCESS_AUD && env.DEMO_AUTH === "true";

// The personas are seed data: they change only on a reseed. The desk layout lists them on every render, and every live
// board event re-renders every open tab, so they are held in this isolate's memory for a few minutes instead of re-read
// from D1 each time. Not KV: that would spend writes (1k/day) to save reads, and a reseed only waits out the TTL.
const DEMO_USERS_TTL_MS = 5 * 60_000;
let demoUsers: { users: User[]; at: number } | null = null;

/** Test hook: forget the cached persona list. */
export const resetDemoUsersCache = () => {
  demoUsers = null;
};

/** The seeded demo personas, for the sign-in page and the persona switcher. Empty when demo sign-in is off. */
export async function listDemoUsers(env: Env): Promise<{ users: User[]; demo: boolean }> {
  if (!demoAuthOn(env)) return { users: [], demo: false };
  if (!demoUsers || Date.now() - demoUsers.at > DEMO_USERS_TTL_MS) {
    const { results } = await env.DB.prepare(`SELECT email, name, role FROM users WHERE email LIKE ? ORDER BY role, name`).bind(`%${DEMO_DOMAIN}`).all<User>();
    // An empty list (read before the seed ran) is not cached, so personas show up as soon as they exist.
    if (!results.length) return { users: [], demo: true };
    demoUsers = { users: results, at: Date.now() };
  }
  return { users: [...demoUsers.users], demo: true };
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
 * How much on the board (the same notices as `loadBoard`) waits on this role: pharmacists review substitutes; planners
 * and ops leads act on open lots and on notices that need triage (needs_triage or failed; dismissed ones are off the
 * board). One query, so the desk header can show it without loading the board.
 */
export async function countNeedsMe(env: Env, role: Role): Promise<number> {
  const status = role === "pharmacist" ? "needs_pharmacist" : "open";
  const triage = role === "pharmacist" ? 0 : 1;
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM lots WHERE status = ? AND notice_id IN (${BOARD_NOTICE_IDS_SQL}))
          + (CASE WHEN ? = 1 THEN (SELECT COUNT(*) FROM notices WHERE status IN ('needs_triage', 'failed') AND id IN (${BOARD_NOTICE_IDS_SQL})) ELSE 0 END) AS n`,
  )
    .bind(status, triage)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
