"use client";

import { useActionState } from "react";
import { idleState } from "../../../src/actions/state";
import { signInAction } from "../../_lib/actions";

export function PersonaButton({ email, label, hint }: { email: string; label: string; hint: string }) {
  const [state, action, pending] = useActionState(signInAction, idleState);
  return (
    <form action={action} className="row gap wrap">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="next" value="/app" />
      <button className="primary" disabled={pending}>
        {pending ? "Signing in…" : `Sign in as ${label}`}
      </button>
      <span className="muted small">{hint}</span>
      {state.ok === false && (
        <span className="error small" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
