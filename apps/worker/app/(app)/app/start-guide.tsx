"use client";

import { Check, X } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";
import { idleState } from "../../../src/actions/state";
import { noticeAction } from "../../_lib/actions";
import { JOURNEY_SAMPLES, fetchSample, sampleName } from "./samples";

const STEPS = ["Add a notice", "Review the split", "Commit it"];

const KEY = "shortstop.guide.hidden";

/**
 * Whether this browser closed the guide. `null` until mounted (localStorage is client-only), so the server render and
 * the first client render agree. Storage can throw (private mode, blocked site data): the guide then just shows.
 */
export function useGuideHidden(): [boolean | null, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  const set = (h: boolean) => {
    setHidden(h);
    try {
      if (h) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      // Not remembered; it still closes for now.
    }
  };
  return [hidden, set];
}

/**
 * "How the desk works": three steps and one-click samples, shown on an empty board until closed. A sample already
 * submitted says so, so a second click doesn't quietly duplicate its lots.
 */
export function StartGuide({ canSubmit, filenames, onClose }: { canSubmit: boolean; filenames: Set<string>; onClose: () => void }) {
  const [state, submitAction, busy] = useActionState(noticeAction, idleState);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (state.ok === false) setError(state.message ?? "could not submit the sample");
  }, [state]);

  const send = async (path: string) => {
    setError(null);
    setSending(path);
    try {
      const form = new FormData();
      form.set("file", await fetchSample(path));
      startTransition(() => submitAction(form));
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load the sample");
    }
  };

  return (
    <section className="panel start-guide" aria-labelledby="guide-title">
      <div className="guide-head">
        <h2 id="guide-title">How the desk works</h2>
        <button type="button" className="ghost icon-only" aria-label="Close the guide" onClick={onClose}>
          <X className="icon" />
        </button>
      </div>
      <ol className="steps short small">
        {STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="stack" style={{ gap: 10 }}>
        <span className="small muted">Try a sample notice:</span>
        <div className="row gap wrap">
          {JOURNEY_SAMPLES.map((s) =>
            filenames.has(sampleName(s.file)) ? (
              <span key={s.file} className="row gap small sample">
                <Check className="icon" aria-hidden /> <b>{s.label}</b> already submitted
                {canSubmit && (
                  <button type="button" className="link small" disabled={busy} onClick={() => void send(s.file)}>
                    Submit again
                  </button>
                )}
              </span>
            ) : (
              <button key={s.file} type="button" className="primary" disabled={!canSubmit || busy} onClick={() => void send(s.file)}>
                {busy && sending === s.file ? "Submitting…" : s.label}
              </button>
            ),
          )}
        </div>
        {!canSubmit && <span className="muted small">Only planners and the ops lead can add notices.</span>}
        {error && (
          <span className="error small" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
