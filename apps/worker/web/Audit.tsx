import { Bot, Search, UserRound } from "lucide-react";
import { sumQuantity } from "@shortstop/shared";
import { useEffect, useState } from "react";
import { api, fmt, relativeTime } from "./api";

type Entry = { id: string; entity: string; entity_id: string; action: string; actor: string; at: number; payload: Record<string, unknown> };

const ACTIONS: Record<string, string> = {
  "notice.received": "Notice uploaded",
  "notice.processing": "Notice being read",
  "notice.ready": "Notice ready",
  "notice.needs_triage": "Notice sent to triage",
  "notice.failed": "Notice failed",
  "lot.planned": "Lot planned",
  "lot.reserved": "Autopilot reserved",
  "lot.auto_committed": "Autopilot committed",
  "lot.committed": "Committed",
  "lot.commit_rejected": "Commit rejected",
  "lot.reservation_cancelled": "Autopilot cancelled",
  "lot.taken_over": "Autopilot taken over",
  "lot.substitute_approved": "Substitute approved",
  "lot.substitute_rejected": "Substitute rejected",
  "lot.precedent_attached": "Precedent attached",
  "policy.saved": "Policy saved",
  "queue.dead_letter": "Dead-lettered",
  "cover.rescored": "Cover re-scored",
};

/** One readable line per payload, with the raw JSON a click away for investigations. */
function describe(p: Record<string, unknown>): string {
  const allocations = p.allocations as { quantity: number }[] | undefined;
  if (allocations) return `${fmt.format(sumQuantity(allocations))} units to ${allocations.length} sites`;
  if (typeof p.reason === "string") return p.reason.replaceAll("_", " ");
  if (Array.isArray(p.rules)) return `${p.rules.length} rules`;
  if (typeof p.action === "string") return `${p.action.replaceAll("_", " ")}${p.ruleId ? ` via ${p.ruleId}` : ""}`;
  if (typeof p.wholesaler === "string") return p.wholesaler;
  if (typeof p.filename === "string") return p.filename;
  if (typeof p.error === "string") return p.error;
  return "";
}

export function AuditView({ tick }: { tick: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<{ entries: Entry[] }>("/audit?limit=300").then((d) => setEntries(d.entries));
  }, [tick]);

  if (!entries) return <p className="muted" role="status">Loading audit trail…</p>;
  const f = filter.toLowerCase();
  const shown = f ? entries.filter((e) => `${e.action} ${ACTIONS[e.action] ?? ""} ${e.actor} ${e.entity_id}`.toLowerCase().includes(f)) : entries;

  return (
    <section className="panel stack">
      <div className="row between wrap">
        <div>
          <h2>Audit trail</h2>
          <p className="muted small">Every change, written in the same transaction as the change itself. Autopilot entries name the rule and policy version.</p>
        </div>
        <div className="search-inline" style={{ minWidth: "min(300px, 100%)" }}>
          <Search className="icon" aria-hidden />
          <input placeholder="Filter by action, person or id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter audit trail" />
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What happened</th>
              <th>Who</th>
              <th>Record</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const auto = e.actor.startsWith("autopilot:") || e.actor === "pipeline" || e.actor === "cron" || e.actor === "queue" || e.actor === "ai-worker";
              return (
                <tr key={e.id}>
                  <td className="nowrap small" title={new Date(e.at).toISOString()}>
                    {relativeTime(e.at)}
                  </td>
                  <td className={e.action === "lot.commit_rejected" ? "error" : ""}>{ACTIONS[e.action] ?? e.action}</td>
                  <td className="small">
                    <span className="actor" style={{ fontWeight: 500 }}>
                      {auto ? <Bot className="icon muted" aria-hidden /> : <UserRound className="icon muted" aria-hidden />}
                      {e.actor}
                    </span>
                  </td>
                  <td className="mono nowrap">{e.entity_id}</td>
                  <td className="small audit-payload">
                    {describe(e.payload)}{" "}
                    <details style={{ display: "inline" }}>
                      <summary className="link" style={{ display: "inline", cursor: "pointer", color: "var(--accent)" }}>
                        raw
                      </summary>
                      <code style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 4 }}>{JSON.stringify(e.payload, null, 1)}</code>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="muted small">No entries match “{filter}”.</p>}
    </section>
  );
}
