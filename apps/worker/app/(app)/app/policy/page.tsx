import { loadPolicy } from "../../../../src/services/policy";
import { viewer, workerEnv } from "../../../_lib/server";
import { POLICY_ACTIONS as ACTIONS } from "../../../_lib/format";
import { RulesEditor, type Rule } from "./rules-editor";

export default async function PolicyPage() {
  const me = await viewer();
  const data = await loadPolicy(await workerEnv());
  return (
    <div className="stack">
      <RulesEditor version={data.current.version} initialRules={data.current.rules as Rule[]} editable={me.role === "ops_lead"} />
      <section className="panel">
        <h2>Version history</h2>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Saved by</th>
              <th>When</th>
              <th>Rules</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{v.createdBy}</td>
                <td title={new Date(v.createdAt).toISOString()}>{new Date(v.createdAt).toUTCString().replace(" GMT", " UTC")}</td>
                <td className="small">{v.rules.length === 0 ? <span className="muted">No rules: every lot is proposed</span> : v.rules.map((r) => `${r.id} → ${ACTIONS.find(([a]) => a === r.then)?.[1] ?? r.then}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
