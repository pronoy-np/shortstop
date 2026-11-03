import { useState } from "react";
import { api, type User } from "./api";

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

export function IntakeView({ me, onSubmitted }: { me: User; onSubmitted: () => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = me.role === "planner" || me.role === "ops_lead";

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

  const submit = async () => {
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (file) form.set("file", file);
    else form.set("text", text);
    try {
      await api("/notices", { method: "POST", body: form });
      setText("");
      setFile(null);
      onSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack">
      <h2>New allocation notice</h2>
      <p className="muted small">
        Upload what the wholesaler sent (PDF, .eml or text) or paste it. Workers AI reads it, the split engine proposes how to share the
        lot across the network, and the autopilot policy decides what a human must review.
      </p>
      {!canSubmit && <p className="warn small">Only planners and the ops lead can submit notices.</p>}
      <div className="row gap wrap">
        {SAMPLES.map(([path, label]) => (
          <button key={path} className="ghost small" onClick={() => loadSample(path)}>
            {label}
          </button>
        ))}
      </div>
      <label className="drop">
        <input
          type="file"
          accept=".pdf,.eml,.txt,application/pdf,message/rfc822,text/plain"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (e.target.files?.[0]) setText("");
          }}
        />
        <span>{file ? `Selected: ${file.name} (${Math.ceil(file.size / 1024)} KB)` : "Choose a PDF, .eml or .txt file (max 5 MB)"}</span>
      </label>
      <textarea
        rows={12}
        placeholder="…or paste the notice text here"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFile(null);
        }}
      />
      {error && <p className="error small">{error}</p>}
      <div>
        <button className="primary" disabled={!canSubmit || busy || (!file && text.trim().length === 0)} onClick={submit}>
          {busy ? "Submitting…" : "Submit notice"}
        </button>
      </div>
    </section>
  );
}
