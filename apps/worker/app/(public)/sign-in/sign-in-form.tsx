"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { idleState } from "../../../src/actions/state";
import { signInAction } from "../../_lib/actions";

type Persona = { email: string; label: string; hint: string; recommended?: boolean };

type TurnstileApi = {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      "timeout-callback"?: () => void;
    },
  ): string;
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
 * hidden `cf-turnstile-response` input inside the form and reports through `onReady` whether there is a usable token
 * (true once it passes; false again when the token expires, the widget errors or times out). `resetOn` changes after
 * each failed submit, since a token is single-use. `onLoadError` fires when Cloudflare's script cannot be loaded.
 */
function Turnstile({ sitekey, resetOn, onReady, onLoadError }: { sitekey: string; resetOn: unknown; onReady: (ready: boolean) => void; onLoadError: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const report = useRef(onReady);
  report.current = onReady;
  const loadError = useRef(onLoadError);
  loadError.current = onLoadError;
  useEffect(() => {
    let gone = false;
    loadTurnstile()
      .then((t) => {
        if (gone || !box.current || id.current !== null) return;
        const no = () => report.current(false);
        id.current = t.render(box.current, {
          sitekey,
          action: "sign-in",
          callback: () => report.current(true),
          "expired-callback": no,
          "error-callback": no,
          "timeout-callback": no,
        });
      })
      .catch(() => {
        // Without the widget there is never a token, and the buttons stay disabled: say why instead of waiting silently.
        if (!gone) loadError.current();
      });
    return () => {
      gone = true;
      if (id.current !== null) window.turnstile?.remove(id.current);
      id.current = null;
    };
  }, [sitekey]);
  useEffect(() => {
    if (id.current === null) return;
    report.current(false);
    window.turnstile?.reset(id.current);
  }, [resetOn]);
  return <div ref={box} className="turnstile" />;
}

/**
 * One form for every persona, so the page has one bot check. The clicked button writes its email into the form.
 * With Turnstile on, the buttons stay disabled until the widget has a token, so nobody can submit an empty check.
 */
export function SignInForm({ personas, sitekey }: { personas: Persona[]; sitekey: string | null }) {
  const [state, action, pending] = useActionState(signInAction, idleState);
  const [verified, setVerified] = useState(false);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const email = useRef<HTMLInputElement>(null);
  const waiting = sitekey !== null && !verified;
  return (
    <form action={action} className="stack">
      <input ref={email} type="hidden" name="email" defaultValue="" />
      <input type="hidden" name="next" value="/app" />
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {personas.map((p) => (
          <li key={p.email} className="row gap wrap">
            <button
              className="primary"
              disabled={pending || waiting}
              onClick={() => {
                if (email.current) email.current.value = p.email;
              }}
            >
              {`Sign in as ${p.label}`}
            </button>
            {p.recommended && <span className="chip start-here">Start here</span>}
            <span className="muted small">{p.hint}</span>
          </li>
        ))}
      </ul>
      {sitekey && <Turnstile sitekey={sitekey} resetOn={state} onReady={setVerified} onLoadError={() => setWidgetFailed(true)} />}
      {widgetFailed && (
        <span className="error small" role="alert">
          The bot check could not load. Allow challenges.cloudflare.com (or turn off your content blocker for this page), then reload.
        </span>
      )}
      {waiting && !widgetFailed && !pending && <span className="muted small">Complete the check above to enable sign-in.</span>}
      {pending && <span className="muted small">Signing in…</span>}
      {state.ok === false && (
        <span className="error small" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
