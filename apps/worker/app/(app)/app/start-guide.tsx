"use client";

import { Check } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";
import { idleState } from "../../../src/actions/state";
import { noticeAction } from "../../_lib/actions";
import { JOURNEY_SAMPLES, fetchSample, sampleName } from "./samples";

const STEPS: [title: string, detail: string][] = [
  ["Add a notice", "Submit what the wholesaler sent. AI reads it into lots: one per drug."],
  [
    "Review the proposed split",
    "Each lot gets a split across the hospitals, worked out by a fixed formula, never the AI. Open a lot to see it.",
  ],
  ["Commit", "A planner commits the split. Low-risk lots commit on autopilot, with 15 minutes to cancel or take over."],
];

// The person's last open/closed choice. Module state, so it survives the board remounting after a sample's redirect.
let remembered: boolean | null = null;

/**
 * "How the desk works": the three steps and one-click samples. Open by default on an empty board and collapsed
 * once lots exist. A sample already submitted says so, so a second click doesn't quietly duplicate its lots.
 */
export function StartGuide({ open, canSubmit, filenames }: { open: boolean; canSubmit: boolean; filenames: Set<string> }) {
  const [state, submitAction, busy] = useActionState(noticeAction, idleState);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts open on an empty board, then stays as the person left it: the first sample must not snap it shut.
  const [expanded, setExpanded] = useState(remembered ?? open);
  useEffect(() => {
    if (state.ok === false) setError(state.message ?? "could not submit the sample");
  }, [state]);

  const send = async (path: string) => {
    setError(null);
    remembered = true;
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
    <details
      className="panel start-guide"
      open={expanded}
      onToggle={(e) => {
        remembered = e.currentTarget.open;
        setExpanded(remembered);
      }}
    >
      <summary>How the desk works</summary>
      <ol className="steps">
        {STEPS.map(([title, detail]) => (
          <li key={title}>
            <b>{title}</b>
            <span className="muted small">{detail}</span>
          </li>
        ))}
      </ol>
      <div className="stack">
        <span className="small">
          <b>Try it with a sample notice.</b>{" "}
          <span className="muted">One click submits it; its lots appear on the board in a few seconds.</span>
        </span>
        <div className="samples">
          {JOURNEY_SAMPLES.map((s) => {
            const there = filenames.has(sampleName(s.file));
            return (
              <div key={s.file} className="sample">
                {there ? (
                  <span className="row gap small">
                    <Check className="icon" aria-hidden /> <b>{s.label}</b> already submitted
                    {canSubmit && (
                      <button type="button" className="link small" disabled={busy} onClick={() => void send(s.file)}>
                        Submit again
                      </button>
                    )}
                  </span>
                ) : (
                  <button type="button" className="primary" disabled={!canSubmit || busy} onClick={() => void send(s.file)}>
                    {busy && sending === s.file ? "Submitting…" : s.label}
                  </button>
                )}
                <span className="muted small">{s.shows}</span>
              </div>
            );
          })}
        </div>
        {!canSubmit && (
          <span className="callout warn small">Only planners and the ops lead can add notices. Switch persona at the top right.</span>
        )}
        {error && (
          <span className="error small" role="alert">
            {error}
          </span>
        )}
      </div>
    </details>
  );
}
