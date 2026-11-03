import { useEffect, useState } from "react";
import { api } from "./api";

type Entry = { id: string; entity: string; entity_id: string; action: string; actor: string; at: number; payload: unknown };

export function AuditView({ tick }: { tick: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<{ entries: Entry[] }>("/audit?limit=300").then((d) => setEntries(d.entries));
  }, [tick]);

  if (!entries) return <div className="panel muted">Loading audit trail…</div>;
  const f = filter.toLowerCase();
  const shown = f ? entries.filter((e) => `${e.action} ${e.actor} ${e.entity_id}`.toLowerCase().includes(f)) : entries;

  return (
    <section className="panel stack">
      <div className="row between wrap">
        <h2>Audit trail</h2>
        <input placeholder="Filter by action, actor or id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter audit trail" />
      </div>
      <p className="muted small">Every state change is written here and to the Worker logs as an [AUDIT] line. Autopilot actors show the rule and policy version that fired.</p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Entity</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id}>
              <td className="nowrap small">{new Date(e.at).toLocaleString()}</td>
              <td>
                <code>{e.action}</code>
              </td>
              <td className="small">{e.actor}</td>
              <td className="small mono">{e.entity_id}</td>
              <td className="small mono details">{JSON.stringify(e.payload)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
