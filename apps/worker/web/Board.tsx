import { useEffect, useMemo, useState } from "react";
import { ApiError, api, fileUrl, type Allocation, type Board, type Lot, type Notice, type Proposal, type Site, type User } from "./api";

const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  processing: "Reading…",
  ready: "Ready",
  needs_triage: "Needs triage",
  failed: "Failed",
  open: "Awaiting planner",
  needs_pharmacist: "Awaiting pharmacist",
  reserved: "Autopilot pending",
  committed: "Committed",
};

const ACTION_LABEL = { auto_commit: "auto-commit", propose: "propose", manual_only: "manual only" } as const;

export function BoardView({ me, board, onChange }: { me: User; board: Board | null; onChange: () => void }) {
  if (!board) return <div className="panel muted">Loading board…</div>;
  const others = board.viewers.filter((v) => v !== me.name);
  return (
    <div className="stack">
      <div className="presence muted">
        {others.length ? `Also on the board: ${others.join(", ")}` : "You are the only one on the board right now."}
      </div>
      {board.notices.length === 0 && (
        <div className="panel muted">No allocation notices yet. Use “New notice” to upload one, or load a sample.</div>
      )}
      {board.notices.map((n) => (
        <NoticeCard key={n.id} notice={n} sites={board.sites} me={me} onChange={onChange} />
      ))}
    </div>
  );
}

function NoticeCard({ notice, sites, me, onChange }: { notice: Notice; sites: Site[]; me: User; onChange: () => void }) {
  return (
    <section className="panel notice">
      <header className="row between">
        <div>
          <h2>{notice.wholesaler ?? notice.filename}</h2>
          <div className="muted small">
            {notice.noticeRef && <>Ref {notice.noticeRef} · </>}
            {notice.filename} · uploaded by {notice.createdBy} · {new Date(notice.createdAt).toLocaleString()}
            {notice.confidence !== null && <> · extraction confidence {Math.round(notice.confidence * 100)}%</>}
          </div>
        </div>
        <div className="row gap">
          <a className="link small" href={fileUrl(`notices/${notice.id}/${notice.filename}`)} target="_blank" rel="noreferrer">
            Original
          </a>
          <span className={`chip s-${notice.status}`}>{STATUS_LABEL[notice.status]}</span>
        </div>
      </header>
      {notice.error && <p className={notice.status === "ready" ? "warn small" : "error small"}>{notice.error}</p>}
      <div className="lots">
        {notice.lots.map((l) => (
          <LotCard key={l.id} lot={l} sites={sites} me={me} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function useCountdown(until: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.round((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function LotCard({ lot, sites, me, onChange }: { lot: Lot; sites: Site[]; me: User; onChange: () => void }) {
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const canPlan = me.role === "planner" || me.role === "ops_lead";
  const countdown = useCountdown(lot.status === "reserved" ? lot.finalizesAt : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // Take-over hands the reserved split to the planner as the editor's starting point.
  const [handoff, setHandoff] = useState<Allocation[] | null>(null);

  const act = async <T,>(fn: () => Promise<T>, done?: string, then?: (r: T) => void) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      then?.(r);
      if (done) setMsg({ kind: "info", text: done });
      onChange();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const commits = useMemo(() => {
    const by = new Map<string, Lot["committed"]>();
    for (const a of lot.committed) by.set(a.commitKey, [...(by.get(a.commitKey) ?? []), a]);
    return [...by.entries()];
  }, [lot.committed]);

  return (
    <article className={`lot t${lot.drug.tier}`}>
      <header className="row between">
        <div>
          <h3>
            <span className={`tier t${lot.drug.tier}`} title={`Clinical tier ${lot.drug.tier}`}>
              T{lot.drug.tier}
            </span>{" "}
            {lot.drug.name}
          </h3>
          <div className="muted small">
            {lot.quantity} {lot.drug.unit}s · {lot.remaining} unallocated · ETA {lot.eta ?? "not stated"} · {lot.drug.drugClass.replace("_", " ")}
          </div>
        </div>
        <span className={`chip s-${lot.status}`}>{STATUS_LABEL[lot.status]}</span>
      </header>

      <p className="decision small">
        Policy v{lot.policyVersion ?? "–"} · {lot.ruleId ? <code>{lot.ruleId}</code> : "no rule matched"} → <b>{ACTION_LABEL[lot.action]}</b>
        {lot.hardFloor && (
          <span className="floor" title="Hard floors are enforced in code and cannot be overridden by policy">
            hard floor: {lot.hardFloor === "tier1" ? "tier-1 drug needs a human" : "substitute needs a pharmacist"}
          </span>
        )}
      </p>
      <p className="small">{lot.explanation}</p>

      {lot.status === "reserved" && (
        <div className="callout auto row between">
          <span>
            Autopilot will commit the proposed split in <b className="mono">{countdown}</b>
          </span>
          {canPlan && (
            <span className="row gap">
              <button
                disabled={busy}
                onClick={() =>
                  act(
                    () => api<{ allocations: Allocation[] }>(`/lots/${lot.id}/reservation`, { method: "POST", json: { mode: "takeover", key: crypto.randomUUID() } }),
                    "Taken over: the autopilot split is loaded below. Edit it and commit.",
                    (r) => setHandoff(r.allocations),
                  )
                }
              >
                Take over
              </button>
              <button className="ghost" disabled={busy} onClick={() => act(() => api(`/lots/${lot.id}/reservation`, { method: "POST", json: { mode: "cancel", key: crypto.randomUUID() } }))}>
                Cancel
              </button>
            </span>
          )}
        </div>
      )}

      {lot.substitute && (
        <div className={`callout sub s-${lot.substitute.status}`}>
          <div>
            Suggested substitute: <b>{lot.substitute.name}</b> — <span className="muted">{lot.substitute.note}</span>
          </div>
          {lot.substitute.status === "pending" ? (
            me.role === "pharmacist" ? (
              <div className="row gap">
                <button disabled={busy} onClick={() => act(() => api(`/lots/${lot.id}/substitute`, { method: "POST", json: { decision: "approved" } }))}>
                  Approve substitute
                </button>
                <button className="ghost" disabled={busy} onClick={() => act(() => api(`/lots/${lot.id}/substitute`, { method: "POST", json: { decision: "rejected" } }))}>
                  Reject
                </button>
              </div>
            ) : (
              <div className="muted small">Waiting for a pharmacist to review before anything can be committed.</div>
            )
          ) : (
            <div className="small">Pharmacist {lot.substitute.status} the substitute.</div>
          )}
        </div>
      )}

      {lot.status === "open" && canPlan && <AllocationEditor lot={lot} sites={sites} initial={handoff} onCommitted={onChange} />}

      {commits.length > 0 && (
        <div className="commits small">
          {commits.map(([key, rows]) => (
            <div key={key} className="row between commit">
              <span>
                {rows[0]!.kind === "auto" ? "🤖" : "✋"} {rows[0]!.actor} committed{" "}
                {rows.map((r) => `${siteName(r.siteId)} ${r.quantity}`).join(", ")}
              </span>
              <span className="row gap">
                <a className="link" href={fileUrl(`confirmations/${lot.id}/${key.replace(/[^a-zA-Z0-9:_-]/g, "_")}.html`)} target="_blank" rel="noreferrer">
                  Confirmation
                </a>
                <a className="link" href={fileUrl(`confirmations/${lot.id}/${key.replace(/[^a-zA-Z0-9:_-]/g, "_")}.csv`)}>
                  CSV
                </a>
              </span>
            </div>
          ))}
        </div>
      )}
      {msg && <p className={msg.kind === "error" ? "error small" : "info small"}>{msg.text}</p>}
    </article>
  );
}

/**
 * propose: inputs start at the proposed split (one click to commit).
 * manual_only: inputs start empty; the proposal is shown for reference and the planner enters every quantity.
 * A take-over starts from the reserved autopilot split.
 */
function AllocationEditor({ lot, sites, initial, onCommitted }: { lot: Lot; sites: Site[]; initial: Allocation[] | null; onCommitted: () => void }) {
  const manual = lot.action === "manual_only";
  const [proposal, setProposal] = useState<Proposal | null>(lot.remaining === lot.quantity ? lot.proposal : null);
  const [basis, setBasis] = useState(lot.remaining); // what was available when this split was computed
  const [values, setValues] = useState<Record<string, number>>({});
  const [commitKey, setCommitKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "warn"; text: string } | null>(null);

  // Partially committed lots get a fresh split of what's left.
  useEffect(() => {
    if (proposal) return;
    api<{ proposal: Proposal; available: number }>(`/lots/${lot.id}/proposal`).then((r) => {
      setProposal(r.proposal);
      setBasis(r.available);
    });
  }, [lot.id, proposal]);

  // Someone else committed while this editor was open: rebase onto what is left and say why.
  useEffect(() => {
    if (lot.remaining === basis) return;
    const who = lot.committed.at(-1)?.actor;
    setBanner({
      kind: "warn",
      text: `${who ?? "Another planner"} just committed part of this lot. Only ${lot.remaining} ${lot.drug.unit}s are left, and the split below has been rebased to match.`,
    });
    setBasis(lot.remaining);
    setProposal(null);
    setCommitKey(crypto.randomUUID());
  }, [lot.remaining, basis, lot.committed, lot.drug.unit]);

  const fromProposal = () => setValues(Object.fromEntries((proposal?.allocations ?? []).map((a) => [a.siteId, a.quantity])));

  useEffect(() => {
    if (!proposal) return;
    if (initial && lot.remaining === basis && initial.reduce((s, a) => s + a.quantity, 0) <= lot.remaining)
      setValues(Object.fromEntries(initial.map((a) => [a.siteId, a.quantity])));
    else if (manual) setValues({});
    else fromProposal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, initial]);

  if (!proposal) return <div className="muted small">Computing split…</div>;
  const total = Object.values(values).reduce((s, v) => s + (v || 0), 0);
  const over = total > lot.remaining;

  const commit = async () => {
    setBusy(true);
    setBanner(null);
    const allocations: Allocation[] = Object.entries(values)
      .filter(([, q]) => q > 0)
      .map(([siteId, quantity]) => ({ siteId, quantity }));
    try {
      await api(`/lots/${lot.id}/commit`, { method: "POST", json: { commitKey, allocations } });
      onCommitted();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body.proposal) {
        setBanner({
          kind: "warn",
          text: `Someone else committed first. Only ${e.body.available} ${lot.drug.unit}s are left, and the split below has been rebased to match.`,
        });
        setProposal(e.body.proposal as Proposal);
        setBasis(Number(e.body.available));
        setCommitKey(crypto.randomUUID());
        onCommitted();
      } else setBanner({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      {banner && <div className={`callout ${banner.kind}`}>{banner.text}</div>}
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th className="num">Acuity</th>
            <th className="num">Cover after (days)</th>
            <th className="num">Proposed</th>
            <th className="num">Allocate</th>
          </tr>
        </thead>
        <tbody>
          {sites
            .filter((s) => s.id in proposal.coverAfter || values[s.id])
            .map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="num">{s.acuity}</td>
                <td className="num">{proposal.coverAfter[s.id] ?? "–"}</td>
                <td className="num muted">{proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0}</td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    aria-label={`Allocation for ${s.name}`}
                    value={values[s.id] ?? 0}
                    onChange={(e) => setValues((v) => ({ ...v, [s.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                  />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {manual && (
        <p className="small muted">
          Policy says <b>manual only</b>: enter every quantity yourself. The proposed split is shown for reference.
        </p>
      )}
      <div className="row between">
        <span className={over ? "error small" : "muted small"}>
          {total} of {lot.remaining} {lot.drug.unit}s {over && "— more than is available"}
        </span>
        <span className="row gap">
          {manual && (
            <button className="ghost" disabled={busy} onClick={fromProposal}>
              Copy proposal
            </button>
          )}
          <button className="primary" disabled={busy || total === 0 || over} onClick={commit}>
            Commit allocation
          </button>
        </span>
      </div>
    </div>
  );
}
