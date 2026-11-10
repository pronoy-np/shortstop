"use client";

import { checkPolicy, HARD_FLOORS, PolicyRules, type LotRef, type PolicyMoved, type PolicyPreview } from "@shortstop/shared";
import { ArrowDown, ArrowUp, Lock, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Fragment, useRef } from "react";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useState } from "react";
import { idleState } from "../../../../src/actions/state";
import { InfoTip } from "../../../_components/info-tip";
import { policyAction, previewPolicyAction } from "../../../_lib/actions";
import { POLICY_ACTIONS as ACTIONS, type PolicyActionName as Action } from "../../../_lib/format";

export type Rule = {
  id: string;
  when: { tier?: 1 | 2 | 3; drugClass?: string; maxLotQty?: number; minConfidence?: number; needsSubstitute?: boolean };
  then: Action;
};


/** Shorter labels for the editor's select, so the table fits without scrolling sideways. */
const SHORT_LABEL: Record<Action, string> = { auto_commit: "Auto-commit", propose: "Propose", manual_only: "Manual only" };

const isAuto = (r: Rule) => r.then === "auto_commit";

/** Auto-commit only ever applies to lots with no substitute (hard floor), so the rule says so explicitly. */
const normalize = (r: Rule): Rule => (isAuto(r) ? { ...r, when: { ...r.when, needsSubstitute: false } } : r);

const lots = (n: number) => `${n} ${n === 1 ? "lot" : "lots"}`;

/** "moves 2 lots to autopilot and 1 back to planners", or null when nothing moves. */
function movesText(m: PolicyMoved): string | null {
  const parts = [m.toAutopilot ? `${lots(m.toAutopilot)} to autopilot` : "", m.toPlanner ? `${m.toAutopilot ? m.toPlanner : lots(m.toPlanner)} back to planners` : ""];
  const text = parts.filter(Boolean).join(" and ");
  return text || null;
}

/** The lots a save would move, collapsed behind a disclosure when the list is long. */
function LotList({ title, items }: { title: string; items: LotRef[] }) {
  if (items.length === 0) return null;
  const list = (
    <ul className="small">
      {items.map((l) => (
        <li key={l.lotId}>
          {l.drugName} <span className="muted">· {l.noticeLabel}</span>
        </li>
      ))}
    </ul>
  );
  return items.length > 5 ? (
    <details className="small">
      <summary>
        {title} ({items.length})
      </summary>
      {list}
    </details>
  ) : (
    <div className="small">
      <b>{title}</b>
      {list}
    </div>
  );
}

const num = (v: string) => (v === "" ? undefined : Number(v));

/** The rules editor island. The page loads the policy on the server; saving is a Server Action (ops lead only). */
export function RulesEditor({ version, initialRules, editable }: { version: number; initialRules: Rule[]; editable: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [rules, setRulesRaw] = useState<Rule[]>(() => initialRules.map(normalize));
  // Any edit makes an earlier "Saved" note stale, so clear it with the change.
  const setRules: typeof setRulesRaw = (next) => {
    setMsg(null);
    setPreview(null);
    setRulesRaw((rs) => (typeof next === "function" ? next(rs) : next).map(normalize));
  };
  const [state, saveAction, saving] = useActionState(policyAction, idleState);
  // Save is two steps: preview what the rules would move on the desk, then confirm.
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (preview) confirmRef.current?.focus();
  }, [preview]);

  // A newer version arrived (someone saved, or the live refresh): show it unless this person is mid-edit.
  const [seen, setSeen] = useState(version);
  if (version !== seen) {
    setSeen(version);
    if (!editable || JSON.stringify(rules) === JSON.stringify(initialRules.map(normalize))) setRulesRaw(initialRules.map(normalize));
  }

  useEffect(() => {
    if (state.ok === null) return;
    setPreview(null);
    if (!state.ok) {
      setMsg({ kind: "error", text: state.message ?? "could not save" });
      return;
    }
    const moved = state.moved ? movesText(state.moved) : null;
    setMsg({ kind: "info", text: `Saved as v${state.version ?? "?"}. ${moved ? `Moved ${moved}.` : "No open lots changed."}` });
    router.refresh();
  }, [state, router]);

  const update = (i: number, patch: (r: Rule) => Rule) => setRules((rs) => rs.map((r, j) => (j === i ? patch(r) : r)));
  const setWhen = (i: number, key: keyof Rule["when"], value: unknown) =>
    update(i, (r) => {
      const when = { ...r.when } as Record<string, unknown>;
      if (value === undefined || value === "" || Number.isNaN(value)) delete when[key];
      else when[key] = value;
      return { ...r, when: when as Rule["when"] };
    });
  const move = (i: number, d: -1 | 1) =>
    setRules((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + d, 0, r!);
      return next;
    });

  // Floor and first-match conflicts, checked live; the service runs the same check on save.
  const issues = checkPolicy(rules);
  const issuesFor = (i: number) => issues.filter((x) => x.rule === i);

  const save = async () => {
    setMsg(null);
    if (issues.length) {
      setMsg({ kind: "error", text: `Fix ${issues.length === 1 ? "the rule" : `the ${issues.length} rules`} marked above before saving.` });
      return;
    }
    // Same zod schema the server enforces: catch mistakes here, but the server re-checks regardless.
    const check = PolicyRules.safeParse(rules);
    if (!check.success) {
      const issue = check.error.issues[0];
      const where = issue?.path.length ? `rule ${Number(issue.path[0]) + 1}${issue.path.length > 1 ? ` (${issue.path.slice(1).join(".")})` : ""}: ` : "";
      setMsg({ kind: "error", text: `${where}${issue?.message ?? "invalid rules"}` });
      return;
    }
    const form = new FormData();
    form.set("rules", JSON.stringify(rules));
    setPreviewing(true);
    try {
      const r = await previewPolicyAction(idleState, form);
      if (r.ok && r.preview) setPreview(r.preview);
      else setMsg({ kind: "error", text: r.message ?? "could not check the rules" });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setPreviewing(false);
    }
  };

  const confirmSave = () => {
    const form = new FormData();
    form.set("rules", JSON.stringify(rules));
    startTransition(() => saveAction(form));
  };

  return (
    <div className="stack">
      <section className="panel stack">
        <div className="row between wrap">
          <h2>Autopilot policy · v{version}</h2>
          {!editable && <span className="muted small">Only the ops lead can edit.</span>}
        </div>
        <div className="small row gap wrap">
          <span>The first matching rule decides. No match goes to a planner.</span>
          <InfoTip label="How the policy works">
            <p>Rules run top to bottom; the first match wins.</p>
            <p>Auto-commit holds the split for 15 minutes so a planner can cancel or take over, then commits.</p>
            <p>Saving re-checks open lots nobody has touched yet and may move them.</p>
          </InfoTip>
        </div>
        <p className="small floor row gap">
          <ShieldAlert className="icon" aria-hidden /> Hard floors (locked rows) always apply.
        </p>

        <div className="table-scroll">
        <table className="rules">
          <thead>
            <tr>
              <th>#</th>
              <th>Rule id</th>
              <th>Tier</th>
              <th>Drug class</th>
              <th>Max lot qty</th>
              <th>Min confidence</th>
              <th>Needs substitute</th>
              <th>Then</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {HARD_FLOORS.map((f) => (
              <tr key={f.id} className="floor-row" title={f.label}>
                <td>
                  <Lock className="icon" aria-label="Locked hard floor" />
                </td>
                <td>
                  <input disabled value={f.id} title={f.id} aria-label="Rule id" />
                </td>
                <td>
                  <select disabled value={"tier" in f.when ? String(f.when.tier) : ""} aria-label="Tier">
                    <option value="">any</option>
                    <option value="1">1</option>
                  </select>
                </td>
                <td>
                  <input disabled value="" placeholder="any" aria-label="Drug class" />
                </td>
                <td>
                  <input disabled type="number" value="" placeholder="any" aria-label="Max lot quantity" />
                </td>
                <td>
                  <input disabled type="number" value="" placeholder="any" aria-label="Minimum confidence" />
                </td>
                <td>
                  <select disabled value={"needsSubstitute" in f.when ? "true" : ""} aria-label="Needs substitute">
                    <option value="">any</option>
                    <option value="true">yes</option>
                  </select>
                </td>
                <td className="small">Never auto-commit</td>
                {editable && <td className="muted small">In code</td>}
              </tr>
            ))}
            {rules.map((r, i) => (
              <Fragment key={i}>
              <tr className={issuesFor(i).length ? "invalid" : undefined}>
                <td className="muted">{i + 1}</td>
                <td>
                  <input disabled={!editable} value={r.id} title={r.id} onChange={(e) => update(i, (x) => ({ ...x, id: e.target.value }))} aria-label="Rule id" />
                </td>
                <td>
                  <select disabled={!editable} value={r.when.tier ?? ""} onChange={(e) => setWhen(i, "tier", num(e.target.value))} aria-label="Tier">
                    <option value="">{isAuto(r) ? "2 or 3" : "any"}</option>
                    {(!isAuto(r) || r.when.tier === 1) && <option value="1">1</option>}
                    <option value="2">2</option>
                    <option value="3">3</option>
                  </select>
                </td>
                <td>
                  <input disabled={!editable} value={r.when.drugClass ?? ""} placeholder="any" onChange={(e) => setWhen(i, "drugClass", e.target.value || undefined)} aria-label="Drug class" />
                </td>
                <td>
                  <input disabled={!editable} type="number" min={1} value={r.when.maxLotQty ?? ""} placeholder="any" onChange={(e) => setWhen(i, "maxLotQty", num(e.target.value))} aria-label="Max lot quantity" />
                </td>
                <td>
                  <input disabled={!editable} type="number" min={0} max={1} step={0.05} value={r.when.minConfidence ?? ""} placeholder="any" onChange={(e) => setWhen(i, "minConfidence", num(e.target.value))} aria-label="Minimum confidence" />
                </td>
                <td>
                  <select
                    disabled={!editable || isAuto(r)}
                    title={isAuto(r) ? "Locked by a hard floor" : undefined}
                    value={r.when.needsSubstitute === undefined ? "" : String(r.when.needsSubstitute)}
                    onChange={(e) => setWhen(i, "needsSubstitute", e.target.value === "" ? undefined : e.target.value === "true")}
                    aria-label="Needs substitute"
                  >
                    <option value="">any</option>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                </td>
                <td>
                  <select disabled={!editable} value={r.then} onChange={(e) => update(i, (x) => ({ ...x, then: e.target.value as Action }))} aria-label="Action">
                    {ACTIONS.map(([a, label]) => (
                      <option key={a} value={a} title={label}>
                        {SHORT_LABEL[a]}
                      </option>
                    ))}
                  </select>
                </td>
                {editable && (
                  <td className="row gap nowrap">
                    <button className="ghost icon-only" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      <ArrowUp className="icon" />
                    </button>
                    <button className="ghost icon-only" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                      <ArrowDown className="icon" />
                    </button>
                    <button className="ghost icon-only danger" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} aria-label="Delete rule">
                      <Trash2 className="icon" />
                    </button>
                  </td>
                )}
              </tr>
              {issuesFor(i).map((x) => (
                <tr key={x.message} className="rule-issue">
                  <td />
                  <td colSpan={editable ? 8 : 7} className="error small" role="alert">
                    Rule {i + 1} {x.message}.
                  </td>
                </tr>
              ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
        {editable && !preview && (
          <div className="row gap">
            <button className="ghost" onClick={() => setRules((rs) => [...rs, { id: `rule-${rs.length + 1}`, when: {}, then: "propose" }])}>
              <Plus className="icon" aria-hidden /> Add rule
            </button>
            <button className="primary" onClick={() => void save()} disabled={saving || previewing || issues.length > 0}>
              {previewing ? "Checking…" : "Save as new version"}
            </button>
          </div>
        )}
        {editable && preview && (
          <div
            className="callout confirm policy-preview"
            role="group"
            aria-labelledby="policy-preview-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") setPreview(null);
            }}
          >
            <span className="title" id="policy-preview-title">
              {(() => {
                const m = movesText({ toAutopilot: preview.toAutopilot.length, toPlanner: preview.toPlanner.length });
                return m ? `This save moves ${m}.` : "No open lots change.";
              })()}
            </span>
            <LotList title="To autopilot" items={preview.toAutopilot} />
            <LotList title="Back to planners" items={preview.toPlanner} />
            <div className="row gap wrap">
              <button className="primary" ref={confirmRef} onClick={confirmSave} disabled={saving}>
                {saving ? "Saving…" : "Confirm save"}
              </button>
              <button className="ghost" onClick={() => setPreview(null)} disabled={saving}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {msg && (
          <p className={msg.kind === "error" ? "error small" : "info small"} role={msg.kind === "error" ? "alert" : "status"}>
            {msg.text}
          </p>
        )}
      </section>
    </div>
  );
}
