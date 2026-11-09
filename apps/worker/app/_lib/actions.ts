"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  commitForm,
  demoCookieOptions,
  noticeForm,
  policyForm,
  reservationForm,
  signInForm,
  substituteForm,
  type FormState,
} from "../../src/actions/forms";
import { DEMO_COOKIE, demoCookieValue } from "../../src/lib/auth";
import { DEMO_PROOF_COOKIE } from "../../src/lib/turnstile";
import { actionContext } from "./server";

// Each action is a thin wrapper: the request and env from Next, then a transport-free core from src/actions/forms.ts
// (tested in workerd). The board's WebSocket broadcast refreshes other tabs; the acting tab calls router.refresh().

export async function commitAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext();
  return commitForm(env, req, form);
}

export async function reservationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext();
  return reservationForm(env, req, form);
}

export async function substituteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext();
  return substituteForm(env, req, form);
}

export async function noticeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext("/app/intake");
  const r = await noticeForm(env, req, form);
  if (r.ok) redirect("/app");
  return r;
}

export async function policyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext("/app/policy");
  return policyForm(env, req, form);
}

/** Signs in as a demo persona (sets the httpOnly `demo_user` cookie, plus `demo_proof` with Turnstile on). With `next`, redirects there afterwards. */
export async function signInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { env, req } = await actionContext("/sign-in");
  const r = await signInForm(env, req, form);
  if (!("user" in r)) return r;
  const jar = await cookies();
  const opts = demoCookieOptions(new URL(req.url).protocol === "https:");
  jar.set(DEMO_COOKIE, await demoCookieValue(env, r.user.email), opts);
  // Bound to this email: the persona switcher re-sets it on each switch, so it always matches `demo_user`.
  if (r.proof) jar.set(DEMO_PROOF_COOKIE, r.proof, opts);
  else jar.delete(DEMO_PROOF_COOKIE);
  if (form.get("next") === "/app") redirect("/app");
  return { ok: true, message: `Signed in as ${r.user.name}.` };
}
