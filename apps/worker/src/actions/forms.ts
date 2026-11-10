import type { Allocation } from "@shortstop/shared";
import { DEMO_COOKIE, cookie, demoCookieEmail, withActor, type AuthFail, type User } from "../lib/auth";
import { DEMO_PROOF_COOKIE, TURNSTILE_FIELD, demoProof, siteverify, verifyProof, turnstileMode, type Verifier } from "../lib/turnstile";
import { COMMIT_ROLES, SUBSTITUTE_ROLES, cancelReservation, commitLot, reviewSubstitute, storedCommitKey } from "../services/lots";
import { NOTICE_ROLES, dismissNotice, submitNotice } from "../services/notices";
import { POLICY_ROLES, previewPolicy, updatePolicy } from "../services/policy";
import type { Fail } from "../services/result";
import { demoSignIn } from "../services/users";
import type { FormState } from "./state";

export { idleState, type FormState } from "./state";

/**
 * Server Action cores: transport-free, so workerd tests call them with a plain Request and FormData. Each Next.js
 * Server Action (app/_lib/actions.ts) is a 3-line wrapper that builds the Request from `headers()`, takes `env` from
 * `getCloudflareContext()`, and calls one of these. Every write goes through `withActor` (resolve the user, check the
 * role, spend one WRITE_LIMITER token) and then the same service the Hono API calls, so there is one write path.
 */

/** A service or guard failure as form state: code, message and field errors, plus any extras (proposal, available). */
function failed(r: Fail<object> | AuthFail): FormState {
  const { ok: _ok, ...rest } = r;
  return { ok: false, ...rest };
}

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : undefined);

/** `qty:<siteId>` fields as allocations. Blank fields are skipped; anything else goes to the schema as a number. */
export function allocationsFrom(form: FormData): Allocation[] {
  const out: Allocation[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("qty:") || typeof value !== "string" || value.trim() === "") continue;
    out.push({ siteId: name.slice(4), quantity: Number(value) });
  }
  return out;
}

const commit = withActor("lot.commit", COMMIT_ROLES, commitLot);
/** Fields: lotId, commitKey (one per form instance, so a double submit is a replay), qty:<siteId>. */
export async function commitForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const commitKey = str(form.get("commitKey"));
  const r = await commit(env, req, { lotId: str(form.get("lotId")), commitKey, allocations: allocationsFrom(form) });
  if (!r.ok) return failed(r);
  // The stored key, so the board can link the confirmation document written under it.
  const lotId = str(form.get("lotId"));
  return { ok: true, available: r.available, ...(commitKey && lotId ? { commitKey: storedCommitKey(lotId, commitKey) } : {}) };
}

const reservation = withActor("lot.reservation", COMMIT_ROLES, cancelReservation);
/** Fields: lotId, mode (cancel | takeover). The cancel key is server-derived. */
export async function reservationForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const r = await reservation(env, req, { lotId: str(form.get("lotId")), mode: str(form.get("mode")) });
  return r.ok ? { ok: true, available: r.available, allocations: r.allocations } : failed(r);
}

const substitute = withActor("lot.substitute", SUBSTITUTE_ROLES, reviewSubstitute);
/** Fields: lotId, decision (approved | rejected), note? */
export async function substituteForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const note = str(form.get("note"));
  const r = await substitute(env, req, { lotId: str(form.get("lotId")), decision: str(form.get("decision")), ...(note ? { note } : {}) });
  return r.ok ? { ok: true, message: "Saved." } : failed(r);
}

const notice = withActor("notice.submit", NOTICE_ROLES, submitNotice);
/** Fields: file (wins when non-empty) or text. */
export async function noticeForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const r = await notice(env, req, { file: form.get("file"), text: form.get("text") });
  return r.ok ? { ok: true, noticeId: r.noticeId } : failed(r);
}

/** The rules editor's JSON field, parsed (the schema check runs in the service). */
function rulesFrom(form: FormData): { rules: unknown } | { error: FormState } {
  try {
    return { rules: JSON.parse(str(form.get("rules")) ?? "") as unknown };
  } catch {
    return { error: { ok: false, code: "invalid", message: "rules must be JSON", fieldErrors: { rules: ["rules must be JSON"] } } };
  }
}

const moves = (n: number, where: string) => `${n} ${n === 1 ? "lot" : "lots"} ${where}`;

const policy = withActor("policy.update", POLICY_ROLES, updatePolicy);
/** Fields: rules (the rules editor's JSON). On success: `version` and `moved` (lots moved to autopilot / back to planners). */
export async function policyForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const rules = rulesFrom(form);
  if ("error" in rules) return rules.error;
  const r = await policy(env, req, { rules: rules.rules });
  if (!r.ok) return failed(r);
  const { toAutopilot, toPlanner } = r.moved;
  const parts = [toAutopilot ? moves(toAutopilot, "to autopilot") : "", toPlanner ? moves(toPlanner, "back to planners") : ""].filter(Boolean);
  const movedText = parts.length ? ` It moved ${parts.join(" and ")}.` : " No lots on the desk changed hands.";
  return { ok: true, version: r.version, moved: r.moved, message: `Saved as policy version ${r.version}. New notices use it immediately.${movedText}` };
}

const preview = withActor("policy.preview", POLICY_ROLES, previewPolicy);
/** Fields: rules (the rules editor's JSON). Saves nothing; on success `preview` lists the lots a save would move. */
export async function previewPolicyForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const rules = rulesFrom(form);
  if ("error" in rules) return rules.error;
  const r = await preview(env, req, { rules: rules.rules });
  return r.ok ? { ok: true, preview: { toAutopilot: r.toAutopilot, toPlanner: r.toPlanner } } : failed(r);
}

const dismiss = withActor("notice.dismiss", NOTICE_ROLES, dismissNotice);
/** Fields: noticeId, reason (1-200 characters). */
export async function dismissNoticeForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const r = await dismiss(env, req, { noticeId: str(form.get("noticeId")), reason: str(form.get("reason")) });
  return r.ok ? { ok: true, noticeId: r.noticeId, message: "Dismissed." } : failed(r);
}

/**
 * Fields: email, and the Turnstile token. On success the transport sets the httpOnly `demo_user` cookie to
 * `user.email` and, with Turnstile on, the `demo_proof` cookie to `proof`. With Turnstile on, a caller needs a token that
 * siteverify accepts, unless their `demo_proof` cookie proves this browser already passed the check for the email in
 * its `demo_user` cookie (the desk's persona switcher). The plain cookie or an x-demo-user header proves nothing:
 * anyone can send them.
 */
export async function signInForm(
  env: Env,
  req: Request,
  form: FormData,
  verify: Verifier = siteverify(),
): Promise<{ ok: true; user: User; proof?: string } | FormState> {
  const mode = turnstileMode(env);
  if (mode === "misconfigured") {
    console.warn("TURNSTILE_SITEKEY is set without TURNSTILE_SECRET: refusing sign-in");
    return { ok: false, code: "forbidden", message: "Sign-in is unavailable right now: the bot check is not configured." };
  }
  let issuedAt: number | null = null; // a valid proof's issue time, carried over so a switch never extends it
  if (mode === "on") {
    const secret = env.TURNSTILE_SECRET!;
    // The demo_user cookie is signed with Turnstile on: the email inside it only counts once the signature checks out.
    const stored = cookie(req, DEMO_COOKIE);
    const current = stored ? (await demoCookieEmail(env, stored))?.toLowerCase() : null;
    issuedAt = current ? await verifyProof(secret, current, cookie(req, DEMO_PROOF_COOKIE)) : null;
    if (issuedAt === null) {
      const token = str(form.get(TURNSTILE_FIELD));
      if (!token || token.length > 2048) return { ok: false, code: "invalid", message: "Complete the bot check, then sign in." };
      if (!(await verify(secret, token, req.headers.get("cf-connecting-ip"))))
        return { ok: false, code: "forbidden", message: "The bot check did not pass. Try it again." };
    }
  }
  const r = await demoSignIn(env, form.get("email"));
  if (!r.ok) return failed(r);
  return mode === "on" ? { ...r, proof: await demoProof(env.TURNSTILE_SECRET!, r.user.email, issuedAt ?? undefined) } : r;
}

/** The `demo_user` cookie's attributes: httpOnly (no script reads it), Lax (sent on top-level navigations), 30 days. */
export const demoCookieOptions = (secure: boolean) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: 60 * 60 * 24 * 30 });
