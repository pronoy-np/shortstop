import { Bot, Check, ChevronRight, FileText, Inbox, Keyboard, Search, ShieldAlert, Sparkles, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ACTION_LABEL,
  ApiError,
  STATUS_LABEL,
  api,
  classLabel,
  displayName,
  fileUrl,
  fmt,
  needsMe,
  relativeTime,
  type Allocation,
  type Board,
  type Lot,
  type Notice,
  type Proposal,
  type Site,
  type User,
} from "./api";

const FILTER_KEYS: Record<string, Filter> = { "1": "needs", "2": "auto", "3": "done", "4": "all" };
const SHORTCUTS: [keys: string[], what: string][] = [
  [["j"], "Next lot"],
  [["k"], "Previous lot"],
  [["o"], "Open or close the lot"],
  [["/"], "Search past lots"],
  [["1", "2", "3", "4"], "Needs you · Autopilot · Done · All"],
  [["Esc"], "Close search, help or a confirmation"],
  [["?"], "Show these shortcuts"],
];

const COVER_FLOOR_DAYS = 5;
const COVER_SCALE_DAYS = 30;
const URGENT_SECONDS = 120;

type Filter = "needs" | "auto" | "done" | "all";
type Row = Lot & { notice: Notice };
type SearchHit = { lotId: string; score: number; summary: string; lot: { status: string } };

const confirmationBase = (lotId: string, key: string) => `confirmations/${lotId}/${key.replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
const minCover = (p: Proposal) => {
  const v = Object.values(p.coverAfter);
  return v.length ? Math.min(...v) : Infinity;
};

/** Triage order: what needs this person first, then autopilot, then the rest; within that, tier then lowest cover. */
function rank(l: Row, me: User) {
  const group = needsMe(l, me.role) ? 0 : l.status === "reserved" ? 1 : l.status === "committed" ? 3 : 2;
  return [group, l.drug.tier, minCover(l.proposal), -l.notice.createdAt] as const;
}

export function BoardView({ me, board, onChange }: { me: User; board: Board | null; onChange: () => void }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  // Lots this person just acted on stay in view (with their success state) until the filter changes.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const headRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  const rows: Row[] = useMemo(() => {
    if (!board) return [];
    const all = board.notices.flatMap((n) => n.lots.map((l) => ({ ...l, notice: n })));
    return all.sort((a, b) => {
      const ra = rank(a, me);
      const rb = rank(b, me);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (ra[i] as number) - (rb[i] as number);
      return 0;
    });
  }, [board, me]);

  const counts = useMemo(
    () => ({
      needs: rows.filter((r) => needsMe(r, me.role)).length,
      auto: rows.filter((r) => r.status === "reserved").length,
      done: rows.filter((r) => r.status === "committed").length,
      all: rows.length,
    }),
    [rows, me.role],
  );
  const active: Filter = filter ?? (counts.needs > 0 ? "needs" : "all");
  const shown = rows.filter(
    (r) =>
      pinned.has(r.id) ||
      (active === "needs" ? needsMe(r, me.role) : active === "auto" ? r.status === "reserved" : active === "done" ? r.status === "committed" : true),
  );
  const chooseFilter = (f: Filter) => {
    setPinned(new Set());
    setFilter(f);
  };

  // Open the most urgent lot once, so the first thing on screen is the next decision.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || shown.length === 0) return;
    seeded.current = true;
    setOpen(new Set([shown[0]!.id]));
  }, [shown]);

  // Keyboard accelerators for planners working a queue. Deliberately unanimated: they run many times a day.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      const ids = shown.map((l) => l.id);
      const current = ids.findIndex((id) => headRefs.current.get(id) === document.activeElement);
      const focusAt = (i: number) => {
        const id = ids[Math.max(0, Math.min(ids.length - 1, i))];
        if (id) headRefs.current.get(id)?.focus();
      };
      if (e.key === "j") focusAt(current + 1);
      else if (e.key === "k") focusAt(current <= 0 ? 0 : current - 1);
      else if (e.key === "o" && current >= 0) headRefs.current.get(ids[current]!)?.click();
      else if (e.key === "/") searchRef.current?.focus();
      else if (e.key === "?") setHelp((h) => !h);
      else if (FILTER_KEYS[e.key]) chooseFilter(FILTER_KEYS[e.key]!);
      else if (e.key === "Escape") {
        setHelp(false);
        setHits(null);
        setSearchError(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);

  if (!board) return <p className="muted" role="status">Loading board…</p>;

  const pending = board.notices.filter((n) => n.status !== "ready");
  const others = board.viewers.filter((v) => v !== me.name);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      setHits((await api<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q.trim())}`)).hits);
    } catch (err) {
      setSearchError((err as Error).message);
      setHits(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter lots">
          {(
            [
              ["needs", "Needs you"],
              ["auto", "Autopilot"],
              ["done", "Done"],
              ["all", "All"],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button key={id} aria-pressed={active === id} onClick={() => chooseFilter(id)}>
              {label} <span className="count">{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="row gap grow" style={{ justifyContent: "flex-end" }}>
          <form className="search-inline" role="search" onSubmit={search}>
            <Search className="icon" aria-hidden />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search past lots by meaning"
              aria-label="Search past lots by meaning"
              aria-keyshortcuts="/"
            />
            <kbd className="kbd-hint" aria-hidden>
              /
            </kbd>
          </form>
          <button className="ghost icon-only" aria-label="Keyboard shortcuts" aria-expanded={help} aria-keyshortcuts="?" onClick={() => setHelp((h) => !h)}>
            <Keyboard className="icon" />
          </button>
        </div>
      </div>

      {help && (
        <section className="panel shortcuts" aria-label="Keyboard shortcuts">
          <div className="row between">
            <h2>Keyboard shortcuts</h2>
            <button className="ghost icon-only" aria-label="Close shortcuts" onClick={() => setHelp(false)}>
              <X className="icon" />
            </button>
          </div>
          <dl>
            {SHORTCUTS.map(([keys, what]) => (
              <div key={what}>
                <dt>
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(hits || searchError || searching) && (
        <div className="panel stack" style={{ marginBottom: 12 }}>
          <div className="row between">
            <h2>{searching ? "Searching…" : `Similar lots for “${q}”`}</h2>
            <button
              className="ghost icon-only"
              aria-label="Close search results"
              onClick={() => {
                setHits(null);
                setSearchError(null);
              }}
            >
              <X className="icon" />
            </button>
          </div>
          {searchError && <p className="error small">{searchError}</p>}
          {hits && hits.length === 0 && <p className="muted small">Nothing similar yet. Lots are indexed as notices come in.</p>}
          {hits && hits.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Summary</th>
                    <th className="num">Match</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {hits.map((h) => (
                    <tr key={h.lotId}>
                      <td className="mono nowrap">{h.lotId}</td>
                      <td className="small">{h.summary}</td>
                      <td className="num">{Math.round(h.score * 100)}%</td>
                      <td>
                        <span className={`chip s-${h.lot.status}`}>{STATUS_LABEL[h.lot.status] ?? h.lot.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="notice-strip" aria-label="Notices not yet on the board">
          {pending.map((n) => (
            <div key={n.id} className="notice-row">
              <FileText className="icon muted" aria-hidden />
              <span className="grow small">
                <b>{displayName(n.wholesaler ?? n.filename)}</b>{" "}
                <span className="muted">
                  · {n.filename} · {relativeTime(n.createdAt)}
                </span>
                {n.error && <span className={n.status === "processing" || n.status === "received" ? "muted" : "error"}> · {n.error}</span>}
              </span>
              <span className={`chip s-${n.status}`}>{STATUS_LABEL[n.status]}</span>
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="lots">
          <div className="empty">
            <Inbox className="icon" style={{ width: 28, height: 28 }} aria-hidden />
            {rows.length === 0 ? (
              <>
                <b>No allocation notices yet.</b>
                <span>Upload one under “New notice”, or load a sample there.</span>
              </>
            ) : (
              <>
                <b>Nothing here right now.</b>
                <button className="ghost" onClick={() => chooseFilter("all")}>
                  Show all {counts.all} lots
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="lots">
          {shown.map((l) => (
            <LotRow
              key={l.id}
              lot={l}
              sites={board.sites}
              me={me}
              open={open.has(l.id)}
              onToggle={() => toggle(l.id)}
              onChange={onChange}
              onActed={() => setPinned((p) => new Set(p).add(l.id))}
              headRef={(el) => {
                if (el) headRefs.current.set(l.id, el);
                else headRefs.current.delete(l.id);
              }}
            />
          ))}
        </div>
      )}

      <p className="muted small" style={{ marginTop: 10 }}>
        {others.length ? `Also on the board: ${others.join(", ")}` : "No one else is on the board right now."}
      </p>
    </div>
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
  return Math.max(0, Math.round((until - now) / 1000));
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function LotRow({
  lot,
  sites,
  me,
  open,
  onToggle,
  onChange,
  onActed,
  headRef,
}: {
  lot: Row;
  sites: Site[];
  me: User;
  open: boolean;
  onToggle: () => void;
  onChange: () => void;
  onActed: () => void;
  headRef: (el: HTMLButtonElement | null) => void;
}) {
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const canPlan = me.role === "planner" || me.role === "ops_lead";
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string; links?: string } | null>(null);
  const [handoff, setHandoff] = useState<Allocation[] | null>(null);

  // A brief tint when a change lands on this lot (state indication, not decoration).
  const sig = `${lot.status}:${lot.remaining}:${lot.committed.length}:${lot.substitute?.status ?? ""}`;
  const prev = useRef(sig);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current === sig) return;
    prev.current = sig;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 60);
    return () => window.clearTimeout(t);
  }, [sig]);

  const act = async <T,>(fn: () => Promise<T>, then?: (r: T) => void) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      then?.(r);
      onActed();
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

  const low = minCover(lot.proposal);
  const bodyId = `lot-${lot.id}`;

  return (
    <article className="lot" data-open={open} data-flash={flash}>
      <button className="lot-head" ref={headRef} aria-expanded={open} aria-controls={bodyId} aria-keyshortcuts="o" onClick={onToggle}>
        <span className={`tier t${lot.drug.tier}`} title={`Clinical tier ${lot.drug.tier}`}>
          T{lot.drug.tier}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="name" style={{ display: "block" }}>
            {lot.drug.name}
          </span>
          <span className="sub" style={{ display: "block" }}>
            {relativeTime(lot.notice.createdAt)} · {displayName(lot.notice.wholesaler ?? lot.notice.filename)}
            {lot.notice.noticeRef ? ` · ${lot.notice.noticeRef}` : ""}
          </span>
        </span>
        <span className="qty col-qty">
          <b>{fmt.format(lot.remaining)}</b>
          <span className="muted">
            {" "}
            of {fmt.format(lot.quantity)} {lot.drug.unit}s left
          </span>
        </span>
        <span className="col-cover">{Number.isFinite(low) && <CoverBar days={low} />}</span>
        <span style={{ justifySelf: "end" }}>
          <span className={`chip s-${lot.status}`}>{STATUS_LABEL[lot.status]}</span>
        </span>
        <ChevronRight className="icon chev" aria-hidden />
      </button>

      {open && (
        <div className="lot-body" id={bodyId}>
          <div className="decision">
            <span>
              {classLabel(lot.drug.drugClass)} · ETA {lot.eta ?? "not stated"}
              {lot.notice.confidence !== null && lot.notice.confidence < 0.9 && <> · extraction confidence {Math.round(lot.notice.confidence * 100)}%</>}
            </span>
            <span>
              Policy v{lot.policyVersion ?? "–"} · {lot.ruleId ? <code>{lot.ruleId}</code> : "no rule matched"} → <b>{ACTION_LABEL[lot.action]}</b>
            </span>
            {lot.hardFloor && (
              <span className="floor" title="Hard floors are enforced in code and cannot be overridden by policy">
                <ShieldAlert className="icon" aria-hidden />
                {lot.hardFloor === "tier1" ? "Tier-1: a person must commit" : "Substitute: a pharmacist must review"}
              </span>
            )}
          </div>
          <p className="small explanation">{lot.explanation}</p>

          {lot.precedent && (
            <details className="precedent">
              <summary>
                <Sparkles className="icon" aria-hidden /> Precedent from {lot.precedent.sources.length} past lot{lot.precedent.sources.length === 1 ? "" : "s"}
              </summary>
              <p>{lot.precedent.note}</p>
              <p className="muted">AI-written, grounded only in: {lot.precedent.sources.join(", ")}</p>
            </details>
          )}

          {lot.status === "reserved" && (
            <AutopilotCallout
              lot={lot}
              siteName={siteName}
              canPlan={canPlan}
              busy={busy}
              onEdit={() =>
                act(
                  () => api<{ allocations: Allocation[] }>(`/lots/${lot.id}/reservation`, { method: "POST", json: { mode: "takeover", key: crypto.randomUUID() } }),
                  (r) => setHandoff(r.allocations),
                )
              }
              onCancel={() => act(() => api(`/lots/${lot.id}/reservation`, { method: "POST", json: { mode: "cancel", key: crypto.randomUUID() } }))}
            />
          )}

          {lot.substitute && (
            <div className={`callout ${lot.substitute.status === "pending" ? "warn" : ""}`}>
              <div>
                <span className="title">Suggested substitute: {lot.substitute.name}</span>
                {lot.substitute.note && <p className="small">{lot.substitute.note}</p>}
              </div>
              {lot.substitute.status === "pending" ? (
                me.role === "pharmacist" ? (
                  <div className="row gap wrap">
                    <button className="primary" disabled={busy} onClick={() => act(() => api(`/lots/${lot.id}/substitute`, { method: "POST", json: { decision: "approved" } }))}>
                      <Check className="icon" aria-hidden /> Approve substitute
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => act(() => api(`/lots/${lot.id}/substitute`, { method: "POST", json: { decision: "rejected" } }))}>
                      Reject
                    </button>
                  </div>
                ) : (
                  <p className="small">Waiting for a pharmacist to review it. Nothing can be committed until then.</p>
                )
              ) : (
                <p className="small">The pharmacist {lot.substitute.status} this substitute.</p>
              )}
            </div>
          )}

          {msg && (
            <div className={`callout ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
              <span className="title">
                {msg.kind === "success" && <Check className="icon" aria-hidden />}
                {msg.text}
              </span>
              {msg.links && (
                <span className="row gap small">
                  <a href={fileUrl(`${msg.links}.html`)} target="_blank" rel="noreferrer">
                    Open confirmation
                  </a>
                  <a href={fileUrl(`${msg.links}.csv`)}>Download CSV</a>
                </span>
              )}
            </div>
          )}

          {lot.status === "open" && canPlan && (
            <AllocationEditor
              lot={lot}
              sites={sites}
              initial={handoff}
              onCommitted={(summary, key) => {
                setMsg({ kind: "success", text: summary, links: confirmationBase(lot.id, key) });
                onActed();
                onChange();
              }}
              onRebased={onChange}
            />
          )}

          {commits.length > 0 && (
            <div className="commits">
              {commits.map(([key, rows]) => {
                const auto = rows[0]!.kind === "auto";
                const total = rows.reduce((s, r) => s + r.quantity, 0);
                return (
                  <div key={key} className="commit">
                    <span>
                      <span className="actor">
                        {auto ? <Bot className="icon" aria-hidden /> : <UserRound className="icon" aria-hidden />}
                        {auto ? "Autopilot" : rows[0]!.actor}
                      </span>{" "}
                      <span className="muted">
                        committed {fmt.format(total)} to {rows.length} site{rows.length === 1 ? "" : "s"} · {relativeTime(rows[0]!.at)}
                      </span>
                    </span>
                    <span className="row gap">
                      <a href={fileUrl(`${confirmationBase(lot.id, key)}.html`)} target="_blank" rel="noreferrer">
                        Confirmation
                      </a>
                      <a href={fileUrl(`${confirmationBase(lot.id, key)}.csv`)}>CSV</a>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function CoverBar({ days }: { days: number }) {
  const w = `${Math.min(100, (days / COVER_SCALE_DAYS) * 100)}%`;
  const floor = `${(COVER_FLOOR_DAYS / COVER_SCALE_DAYS) * 100}%`;
  return (
    <span className="cover" role="img" aria-label={`${days} days of cover after the split, floor ${COVER_FLOOR_DAYS} days`}>
      <span className="cover-track" aria-hidden>
        <span className={`cover-fill ${days < COVER_FLOOR_DAYS ? "low" : ""}`} style={{ ["--w" as string]: w }} />
        <span className="cover-floor" style={{ ["--floor" as string]: floor }} />
      </span>
      <span className="cover-val" aria-hidden>
        {days}d
      </span>
    </span>
  );
}

function AutopilotCallout(props: { lot: Lot; siteName: (id: string) => string; canPlan: boolean; busy: boolean; onEdit: () => void; onCancel: () => void }) {
  const { lot, siteName } = props;
  const left = useCountdown(lot.finalizesAt);
  const split = lot.proposal.allocations;
  const largest = [...split].sort((a, b) => b.quantity - a.quantity)[0];
  // Screen readers hear the countdown at 5 minutes and 1 minute, not every second.
  const [announce, setAnnounce] = useState("");
  const said = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (left === null) return;
    for (const mark of [300, 60]) {
      if (left <= mark && !said.current.has(mark)) {
        said.current.add(mark);
        setAnnounce(`Autopilot commits ${lot.drug.name} in ${mark / 60} minute${mark === 60 ? "" : "s"}.`);
      }
    }
  }, [left, lot.drug.name]);

  return (
    <div className={`callout auto row ${left !== null && left <= URGENT_SECONDS ? "urgent" : ""}`}>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <span>
        <span className="title">
          <Bot className="icon" aria-hidden /> Autopilot commits in <span className="mono">{left === null ? "–" : mmss(left)}</span>
        </span>
        <span className="small" style={{ display: "block" }}>
          {fmt.format(split.reduce((s, a) => s + a.quantity, 0))} {lot.drug.unit}s to {split.length} sites
          {largest ? `, most to ${siteName(largest.siteId)} (${fmt.format(largest.quantity)})` : ""}.
        </span>
      </span>
      {props.canPlan && (
        <span className="row gap">
          <button disabled={props.busy} onClick={props.onEdit}>
            Edit split
          </button>
          <button className="ghost" disabled={props.busy} onClick={props.onCancel}>
            Cancel autopilot
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * propose: inputs start at the proposed split (one click to commit).
 * manual_only: inputs start empty; the proposal is shown for reference and the planner enters every quantity.
 * A take-over starts from the reserved autopilot split.
 */
function AllocationEditor({
  lot,
  sites,
  initial,
  onCommitted,
  onRebased,
}: {
  lot: Lot;
  sites: Site[];
  initial: Allocation[] | null;
  onCommitted: (summary: string, commitKey: string) => void;
  onRebased: () => void;
}) {
  const manual = lot.action === "manual_only";
  const [proposal, setProposal] = useState<Proposal | null>(lot.remaining === lot.quantity ? lot.proposal : null);
  const [basis, setBasis] = useState(lot.remaining); // what was available when this split was computed
  const [values, setValues] = useState<Record<string, number>>({});
  const [commitKey, setCommitKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "warn"; text: string } | null>(null);
  // Committing ships scarce stock: one deliberate confirm, focused so Enter completes it from the keyboard.
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

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
      text: `${who ?? "Another planner"} just committed part of this lot. ${fmt.format(lot.remaining)} ${lot.drug.unit}s are left, and the split below has been rebased to match.`,
    });
    setBasis(lot.remaining);
    setProposal(null);
    setConfirming(false);
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

  if (!proposal) return <p className="muted small" role="status">Computing the split…</p>;

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const allocations: Allocation[] = Object.entries(values)
    .filter(([, q]) => q > 0)
    .map(([siteId, quantity]) => ({ siteId, quantity }));
  const total = allocations.reduce((s, a) => s + a.quantity, 0);
  const over = total > lot.remaining;
  const lowest = Object.entries(proposal.coverAfter).sort((a, b) => a[1] - b[1])[0];

  const commit = async () => {
    setBusy(true);
    setBanner(null);
    setConfirming(false);
    try {
      await api(`/lots/${lot.id}/commit`, { method: "POST", headers: { "Idempotency-Key": commitKey }, json: { allocations } });
      onCommitted(`Committed ${fmt.format(total)} ${lot.drug.unit}s to ${allocations.length} site${allocations.length === 1 ? "" : "s"}.`, commitKey);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body.proposal) {
        setBanner({
          kind: "warn",
          text: `Someone else committed first. ${fmt.format(Number(e.body.available))} ${lot.drug.unit}s are left, and the split below has been rebased to match.`,
        });
        setProposal(e.body.proposal as Proposal);
        setBasis(Number(e.body.available));
        setCommitKey(crypto.randomUUID());
        onRebased();
      } else setBanner({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      {banner && (
        <div className={`callout ${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
          {banner.text}
        </div>
      )}
      {manual && <p className="small muted">Policy says manual only: enter each quantity yourself. The proposed split is shown for reference.</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th className="num hide-sm">Acuity</th>
              <th>Cover after split</th>
              <th className="num hide-sm">Proposed</th>
              <th className="num">Allocate</th>
            </tr>
          </thead>
          <tbody>
            {sites
              .filter((s) => s.id in proposal.coverAfter || values[s.id])
              .map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="num hide-sm">{s.acuity}</td>
                  <td>{s.id in proposal.coverAfter ? <CoverBar days={proposal.coverAfter[s.id]!} /> : "–"}</td>
                  <td className="num muted hide-sm">{fmt.format(proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0)}</td>
                  <td className="num">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      placeholder={String(proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0)}
                      aria-label={`Allocation for ${s.name}`}
                      value={values[s.id] ?? ""}
                      onChange={(e) => {
                        setConfirming(false);
                        setValues((v) => ({ ...v, [s.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }));
                      }}
                    />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="row between wrap">
        <p className={`summary-line ${over ? "error" : "muted"}`} aria-live="polite">
          {total === 0 ? (
            "Nothing allocated yet."
          ) : over ? (
            <>
              <b>{fmt.format(total)}</b> entered, but only <b>{fmt.format(lot.remaining)}</b> {lot.drug.unit}s are left.
            </>
          ) : (
            <>
              <b>{fmt.format(total)}</b> of {fmt.format(lot.remaining)} {lot.drug.unit}s to <b>{allocations.length}</b> site{allocations.length === 1 ? "" : "s"}
              {lowest && !manual ? (
                <>
                  {" "}
                  · lowest cover {siteName(lowest[0])} {lowest[1]}d
                </>
              ) : null}
            </>
          )}
        </p>
        <span className="row gap">
          {manual && (
            <button className="ghost" disabled={busy} onClick={fromProposal}>
              Copy proposal
            </button>
          )}
          {!confirming && (
            <button className="primary" disabled={busy || total === 0 || over} onClick={() => setConfirming(true)}>
              {busy ? "Committing…" : total > 0 && !over ? `Commit ${fmt.format(total)} ${lot.drug.unit}s` : "Commit allocation"}
            </button>
          )}
        </span>
      </div>
      {confirming && (
        <div
          className="callout confirm row"
          role="group"
          aria-labelledby={`confirm-${lot.id}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setConfirming(false);
            }
          }}
        >
          <span>
            <span className="title" id={`confirm-${lot.id}`}>
              Commit {fmt.format(total)} {lot.drug.unit}s of {lot.drug.name} to {allocations.length} site{allocations.length === 1 ? "" : "s"}?
            </span>
            <span className="small" style={{ display: "block" }}>
              {lowest ? `Lowest cover after the split: ${siteName(lowest[0])}, ${lowest[1]} days. ` : ""}The stock is committed to these sites and a
              confirmation is filed.
            </span>
          </span>
          <span className="row gap">
            <button className="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Back to editing
            </button>
            <button className="primary" ref={confirmRef} disabled={busy} onClick={commit}>
              {busy ? "Committing…" : "Confirm commit"}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
