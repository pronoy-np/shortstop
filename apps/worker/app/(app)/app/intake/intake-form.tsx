"use client";

import { NoticeText } from "@shortstop/shared";
import { FileUp, X } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";
import { idleState } from "../../../../src/actions/state";
import { noticeAction } from "../../../_lib/actions";

const SAMPLES: [file: string, label: string][] = [
  ["notices/01-meridian-multi-lot.txt", "Multi-lot notice (text)"],
  ["notices/02-cisplatin-oncology.eml", "Cisplatin allocation (.eml)"],
  ["notices/03-iv-fluids-short.txt", "IV fluids, very short"],
  ["notices/04-pediatric-amoxicillin.txt", "Pediatric amoxicillin"],
  ["notices/05-glp1-pens.txt", "GLP-1 pens"],
  ["notices/06-not-a-notice.txt", "Not a notice (triage)"],
  ["notices/07-unknown-product.txt", "Unknown product (triage)"],
  ["notices/08-epinephrine-letter.pdf", "Emergency syringes (PDF)"],
];

const TYPES: Record<string, string> = { eml: "message/rfc822", pdf: "application/pdf" };

/** Intake island. Submits through the `noticeAction` Server Action, which redirects to the board on success. */
export function IntakeForm({ canSubmit }: { canSubmit: boolean }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, submitAction, busy] = useActionState(noticeAction, idleState);
  useEffect(() => {
    if (state.ok === false) setError(state.message ?? "could not submit the notice");
  }, [state]);

  const loadSample = async (path: string) => {
    const res = await fetch(`/${path}`);
    if (path.endsWith(".txt")) {
      setFile(null);
      setText(await res.text());
    } else {
      const name = path.split("/").pop()!;
      setText("");
      setFile(new File([await res.blob()], name, { type: TYPES[name.split(".").pop()!] ?? "application/octet-stream" }));
    }
  };

  const submit = () => {
    setError(null);
    const form = new FormData();
    if (file) form.set("file", file);
    else {
      // Shared schema: the server applies exactly the same check.
      const check = NoticeText.safeParse(text);
      if (!check.success) {
        setError(check.error.issues[0]?.message ?? "invalid text");
        return;
      }
      form.set("text", check.data);
    }
    startTransition(() => submitAction(form));
  };

  return (
    <section className="panel stack" style={{ maxWidth: 820 }}>
      <div className="row between wrap">
        <h2>New allocation notice</h2>
        <label className="row gap small">
          <span className="muted">Try a sample</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) void loadSample(e.target.value);
            }}
          >
            <option value="">Choose…</option>
            {SAMPLES.map(([path, label]) => (
              <option key={path} value={path}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small" style={{ maxWidth: "70ch" }}>
        Upload what the wholesaler sent, or paste it. It is read, matched to the drug catalog and split across the network; the autopilot
        policy then decides what waits for a person.
      </p>
      {!canSubmit && <div className="callout warn small">Only planners and the ops lead can submit notices. Switch persona at the top right.</div>}
      <label className="drop">
        <FileUp className="icon" aria-hidden />
        <span className="grow">{file ? `${file.name} · ${Math.ceil(file.size / 1024)} KB` : "Choose a PDF, .eml or .txt file (up to 5 MB)"}</span>
        {file && (
          <button
            className="ghost icon-only"
            aria-label="Remove file"
            onClick={(e) => {
              e.preventDefault();
              setFile(null);
            }}
          >
            <X className="icon" />
          </button>
        )}
        <input
          className="sr-only"
          type="file"
          accept=".pdf,.eml,.txt,application/pdf,message/rfc822,text/plain"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (e.target.files?.[0]) setText("");
          }}
        />
      </label>
      <textarea
        rows={12}
        placeholder="Or paste the notice text here"
        aria-label="Notice text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFile(null);
        }}
      />
      {error && (
        <div className="callout error small" role="alert">
          {error}
        </div>
      )}
      <div>
        <button className="primary" disabled={!canSubmit || busy || (!file && text.trim().length === 0)} onClick={submit}>
          {busy ? "Submitting…" : "Submit notice"}
        </button>
      </div>
    </section>
  );
}
