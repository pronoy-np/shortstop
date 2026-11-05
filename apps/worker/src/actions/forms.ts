import type { Allocation } from "@shortstop/shared";
import { withActor, type AuthFail, type User } from "../lib/auth";
import { COMMIT_ROLES, SUBSTITUTE_ROLES, cancelReservation, commitLot, reviewSubstitute } from "../services/lots";
import { NOTICE_ROLES, submitNotice } from "../services/notices";
import { POLICY_ROLES, updatePolicy } from "../services/policy";
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

const commit = withActor(COMMIT_ROLES, commitLot);
/** Fields: lotId, commitKey (one per form instance, so a double submit is a replay), qty:<siteId>. */
export async function commitForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const commitKey = str(form.get("commitKey"));
  const r = await commit(env, req, { lotId: str(form.get("lotId")), commitKey, allocations: allocationsFrom(form) });
  if (!r.ok) return failed(r);
  return { ok: true, available: r.available, ...(commitKey ? { commitKey } : {}) };
}

const reservation = withActor(COMMIT_ROLES, cancelReservation);
/** Fields: lotId, mode (cancel | takeover). The cancel key is server-derived. */
export async function reservationForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const r = await reservation(env, req, { lotId: str(form.get("lotId")), mode: str(form.get("mode")) });
  return r.ok ? { ok: true, available: r.available, allocations: r.allocations } : failed(r);
}

const substitute = withActor(SUBSTITUTE_ROLES, reviewSubstitute);
/** Fields: lotId, decision (approved | rejected), note? */
export async function substituteForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const note = str(form.get("note"));
  const r = await substitute(env, req, { lotId: str(form.get("lotId")), decision: str(form.get("decision")), ...(note ? { note } : {}) });
  return r.ok ? { ok: true, message: "Saved." } : failed(r);
}

const notice = withActor(NOTICE_ROLES, submitNotice);
/** Fields: file (wins when non-empty) or text. */
export async function noticeForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  const r = await notice(env, req, { file: form.get("file"), text: form.get("text") });
  return r.ok ? { ok: true, noticeId: r.noticeId } : failed(r);
}

const policy = withActor(POLICY_ROLES, updatePolicy);
/** Fields: rules (the rules editor's JSON). */
export async function policyForm(env: Env, req: Request, form: FormData): Promise<FormState> {
  let rules: unknown;
  try {
    rules = JSON.parse(str(form.get("rules")) ?? "");
  } catch {
    return { ok: false, code: "invalid", message: "rules must be JSON", fieldErrors: { rules: ["rules must be JSON"] } };
  }
  const r = await policy(env, req, { rules });
  return r.ok ? { ok: true, message: `Saved as policy version ${r.policy.version}. New notices use it immediately.` } : failed(r);
}

/** Field: email. On success the transport sets the httpOnly `demo_user` cookie to `user.email`. */
export async function signInForm(env: Env, form: FormData): Promise<{ ok: true; user: User } | FormState> {
  const r = await demoSignIn(env, form.get("email"));
  return r.ok ? r : failed(r);
}

/** The `demo_user` cookie's attributes: httpOnly (no script reads it), Lax (sent on top-level navigations), 30 days. */
export const demoCookieOptions = (secure: boolean) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: 60 * 60 * 24 * 30 });
