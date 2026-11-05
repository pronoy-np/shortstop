"use client";

import { useActionState, useEffect, useRef } from "react";
import { idleState } from "../../../src/actions/state";
import { signInAction } from "../../_lib/actions";

type Persona = { email: string; label: string; hint: string };

type TurnstileApi = {
  render(el: HTMLElement, opts: { sitekey: string; action?: string; "response-field-name"?: string }): string;
  reset(id: string): void;
  remove(id: string): void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's widget script once per page, however many times the form mounts. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * The widget, rendered explicitly so it also works after client-side navigation. It writes its one-time token into a
 * hidden `cf-turnstile-response` input inside the form; `resetOn` changes after each failed submit, since a token is
 * single-use.
 */
function Turnstile({ sitekey, resetOn }: { sitekey: string; resetOn: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  useEffect(() => {
    let gone = false;
    loadTurnstile()
      .then((t) => {
        if (!gone && box.current && id.current === null) id.current = t.render(box.current, { sitekey, action: "sign-in" });
      })
      .catch(() => {
        // The server refuses the submit without a token, and the form shows why.
      });
    return () => {
      gone = true;
      if (id.current !== null) window.turnstile?.remove(id.current);
      id.current = null;
    };
  }, [sitekey]);
  useEffect(() => {
    if (id.current !== null) window.turnstile?.reset(id.current);
  }, [resetOn]);
  return <div ref={box} className="turnstile" />;
}

/** One form for every persona, so the page has one bot check. The clicked button writes its email into the form. */
export function SignInForm({ personas, sitekey }: { personas: Persona[]; sitekey: string | null }) {
  const [state, action, pending] = useActionState(signInAction, idleState);
  const email = useRef<HTMLInputElement>(null);
  return (
    <form action={action} className="stack">
      <input ref={email} type="hidden" name="email" defaultValue="" />
      <input type="hidden" name="next" value="/app" />
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {personas.map((p) => (
          <li key={p.email} className="row gap wrap">
            <button
              className="primary"
              disabled={pending}
              onClick={() => {
                if (email.current) email.current.value = p.email;
              }}
            >
              {`Sign in as ${p.label}`}
            </button>
            <span className="muted small">{p.hint}</span>
          </li>
        ))}
      </ul>
      {sitekey && <Turnstile sitekey={sitekey} resetOn={state} />}
      {pending && <span className="muted small">Signing in…</span>}
      {state.ok === false && (
        <span className="error small" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
