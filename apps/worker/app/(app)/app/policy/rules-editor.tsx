"use client";

import { PolicyRules } from "@shortstop/shared";
import { ArrowDown, ArrowUp, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useState } from "react";
import { idleState } from "../../../../src/actions/state";
import { policyAction } from "../../../_lib/actions";
import { POLICY_ACTIONS as ACTIONS, type PolicyActionName as Action } from "../../../_lib/format";

export type Rule = {
  id: string;
  when: { tier?: 1 | 2 | 3; drugClass?: string; maxLotQty?: number; minConfidence?: number; needsSubstitute?: boolean };
  then: Action;
};


function describe(rule: Rule) {
  const w = rule.when;
  const parts = [
    w.tier && `tier ${w.tier}`,
    w.drugClass && `class = ${w.drugClass}`,
    w.maxLotQty && `lot ≤ ${w.maxLotQty}`,
    w.minConfidence !== undefined && `confidence ≥ ${w.minConfidence}`,
    w.needsSubstitute !== undefined && (w.needsSubstitute ? "needs substitute" : "no substitute"),
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : "any lot";
}

const num = (v: string) => (v === "" ? undefined : Number(v));

/** The rules editor island. The page loads the policy on the server; saving is a Server Action (ops lead only). */
export function RulesEditor({ version, initialRules, editable }: { version: number; initialRules: Rule[]; editable: boolean }) {
  const router = useRouter();
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [state, saveAction, saving] = useActionState(policyAction, idleState);

  // A newer version arrived (someone saved, or the live refresh): show it unless this person is mid-edit.
  const [seen, setSeen] = useState(version);
  if (version !== seen) {
    setSeen(version);
    if (!editable || JSON.stringify(rules) === JSON.stringify(initialRules)) setRules(initialRules);
  }

  useEffect(() => {
    if (state.ok === null) return;
    setMsg({ kind: state.ok ? "info" : "error", text: state.message ?? (state.ok ? "Saved." : "could not save") });
    if (state.ok) router.refresh();
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

  const save = () => {
    setMsg(null);
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
    startTransition(() => saveAction(form));
  };

  return (
    <div className="stack">
      <section className="panel stack">
        <div className="row between">
          <h2>Autopilot policy · v{version}</h2>
          {!editable && <span className="muted small">Read only: only the ops lead can change the policy.</span>}
        </div>
        <p className="small">
          Rules are checked top to bottom and the <b>first match wins</b>. If nothing matches, the lot is proposed to a planner.
        </p>
        <div className="callout floor-box small">
          <span className="title">
            <ShieldAlert className="icon" aria-hidden /> Hard floors, in code and not configurable
          </span>
          <span>
            Tier-1 drugs never auto-commit, and any lot that needs a substitute waits for a pharmacist. An auto-commit rule that matches one of
            these is downgraded to “propose”.
          </span>
        </div>

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
              <th>Substitute</th>
              <th>Then</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                <td>
                  <input disabled={!editable} value={r.id} onChange={(e) => update(i, (x) => ({ ...x, id: e.target.value }))} aria-label="Rule id" />
                </td>
                <td>
                  <select disabled={!editable} value={r.when.tier ?? ""} onChange={(e) => setWhen(i, "tier", num(e.target.value))} aria-label="Tier">
                    <option value="">any</option>
                    <option value="1">1</option>
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
                    disabled={!editable}
                    value={r.when.needsSubstitute === undefined ? "" : String(r.when.needsSubstitute)}
                    onChange={(e) => setWhen(i, "needsSubstitute", e.target.value === "" ? undefined : e.target.value === "true")}
                    aria-label="Needs substitute"
                  >
                    <option value="">any</option>
                    <option value="true">needed</option>
                    <option value="false">not needed</option>
                  </select>
                </td>
                <td>
                  <select disabled={!editable} value={r.then} onChange={(e) => update(i, (x) => ({ ...x, then: e.target.value as Action }))} aria-label="Action">
                    {ACTIONS.map(([a, label]) => (
                      <option key={a} value={a}>
                        {label}
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
            ))}
          </tbody>
        </table>
        </div>
        <ol className="small muted">
          {rules.map((r, i) => (
            <li key={i}>
              If {describe(r)} → {ACTIONS.find(([a]) => a === r.then)?.[1]}
            </li>
          ))}
          <li>Otherwise → propose to a planner</li>
        </ol>
        {editable && (
          <div className="row gap">
            <button className="ghost" onClick={() => setRules((rs) => [...rs, { id: `rule-${rs.length + 1}`, when: {}, then: "propose" }])}>
              <Plus className="icon" aria-hidden /> Add rule
            </button>
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save as new version"}
            </button>
          </div>
        )}
        {msg && <p className={msg.kind === "error" ? "error small" : "info small"}>{msg.text}</p>}
      </section>
    </div>
  );
}
