"use client";

import {
  DismissReason,
  confirmationBase,
  sumQuantity,
  type Allocation,
  type BoardView,
  type LotView,
  type NoticeView,
  type ProposalView,
  type SiteView,
  type UserView,
} from "@shortstop/shared";
import { ArrowRightLeft, Bot, Check, ChevronRight, FileText, Inbox, Keyboard, Search, ShieldAlert, Sparkles, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { idleState, type FormState } from "../../../src/actions/state";
import type { SearchHitView } from "../../../src/services/search";
import { CoverBar } from "../../_components/cover-bar";
import { commitAction, dismissNoticeAction, reservationAction, substituteAction } from "../../_lib/actions";
import {
  ACTION_LABEL,
  STATUS_HINT,
  STATUS_LABEL,
  TIER_HINT,
  canPlan as plans,
  classLabel,
  displayName,
  fileUrl,
  fmt,
  needsMe,
  relativeTime,
  triageReason,
} from "../../_lib/format";
import { StartGuide, useGuideHidden } from "./start-guide";

type User = UserView;
type Lot = LotView;
type Notice = NoticeView;
type Proposal = ProposalView;
type Site = SiteView;

/** Server-rendered search (`/app?q=`): the query and its hits, or why there are none. */
export type BoardSearch = { q: string; hits: SearchHitView[] | null; error: string | null };

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

const URGENT_SECONDS = 120;

type Filter = "needs" | "auto" | "done" | "all";
type Row = Lot & { notice: Notice };

const minCover = (p: Proposal) => {
  const v = Object.values(p.coverAfter);
  return v.length ? Math.min(...v) : Infinity;
};

/** Triage order: what needs this person first, then autopilot, then the rest; within that, tier then lowest cover. */
function rank(l: Row, me: User) {
  const group = needsMe(l, me.role) ? 0 : l.status === "reserved" ? 1 : l.status === "committed" ? 3 : 2;
  return [group, l.drug.tier, minCover(l.proposal), -l.notice.createdAt] as const;
}

/**
 * The board island. The server page loads the board (with fresh splits for partly committed lots) and any search, so
 * this component makes no data calls: writes are Server Actions, and LiveRefresh re-renders the page on board events.
 */
export function BoardClient({ me, board, search, canSubmit }: { me: User; board: BoardView; search: BoardSearch | null; canSubmit: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  // Lots this person just acted on stay in view (with their success state) until the filter changes.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const headRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  const rows: Row[] = useMemo(() => {
    const all = board.notices.flatMap((n) => n.lots.map((l) => ({ ...l, notice: n })));
    return all.sort((a, b) => {
      const ra = rank(a, me);
      const rb = rank(b, me);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (ra[i] as number) - (rb[i] as number);
      return 0;
    });
  }, [board, me]);

  const planner = plans(me.role);
  // Notices that need a person (not a notice, unknown product, failed). Planners see them under Needs you, matching
  // the tab count; everyone sees them under All.
  const triage = board.notices.filter((n) => n.stage === "triage");
  const reading = board.notices.filter((n) => n.stage === "reading");
  const counts = useMemo(
    () => ({
      needs: rows.filter((r) => needsMe(r, me.role)).length + (planner ? triage.length : 0),
      auto: rows.filter((r) => r.status === "reserved").length,
      done: rows.filter((r) => r.status === "committed").length,
      all: rows.length + triage.length,
    }),
    [rows, me.role, planner, triage.length],
  );
  const active: Filter = filter ?? (counts.needs > 0 ? "needs" : "all");
  const shown = rows.filter(
    (r) =>
      pinned.has(r.id) ||
      (active === "needs" ? needsMe(r, me.role) : active === "auto" ? r.status === "reserved" : active === "done" ? r.status === "committed" : true),
  );
  const triageShown = active === "all" || (active === "needs" && planner) ? triage : [];
  const [guideHidden, setGuideHidden] = useGuideHidden();

  // A policy save moved a lot this planner had open to autopilot: keep it in view and say why, instead of the editor
  // vanishing (or a commit failing for no visible reason). Checked while rendering, so the lot never blinks out.
  const [movedByPolicy, setMovedByPolicy] = useState<Set<string>>(new Set());
  const [seenRows, setSeenRows] = useState(rows);
  if (rows !== seenRows) {
    const before = new Map(seenRows.map((r) => [r.id, r.status]));
    setSeenRows(rows);
    const moved = rows
      .filter((r) => planner && open.has(r.id) && before.get(r.id) === "open" && r.status === "reserved" && r.rerouted?.to === "autopilot")
      .map((r) => r.id);
    if (moved.length) {
      setMovedByPolicy((s) => new Set([...s, ...moved]));
      setPinned((s) => new Set([...s, ...moved]));
    }
  }

  const chooseFilter = (f: Filter) => {
    setMovedByPolicy(new Set());
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
  // One listener for the board's lifetime; it reads the current list through a ref.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const searchOpen = useRef(search !== null);
  searchOpen.current = search !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      const ids = shownRef.current.map((l) => l.id);
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
        if (searchOpen.current) router.push("/app");
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const others = board.viewers.filter((v) => v !== me.name);
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {rows.length === 0 && guideHidden === false && (
        <StartGuide canSubmit={canSubmit} filenames={new Set(board.notices.map((n) => n.filename))} onClose={() => setGuideHidden(true)} />
      )}
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
          <form className="search-inline" role="search" action="/app">
            <Search className="icon" aria-hidden />
            <input
              ref={searchRef}
              name="q"
              defaultValue={search?.q ?? ""}
              minLength={2}
              maxLength={200}
              required
              placeholder="Search past lots"
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

      {search && (
        <div className="panel stack" style={{ marginBottom: 12 }}>
          <div className="row between">
            <h2>{`Similar lots for “${search.q}”`}</h2>
            <Link className="button ghost icon-only" href="/app" prefetch={false} aria-label="Close search results">
              <X className="icon" />
            </Link>
          </div>
          {search.error && <p className="error small">{search.error}</p>}
          {search.hits && search.hits.length === 0 && <p className="muted small">Nothing similar yet.</p>}
          {search.hits && search.hits.length > 0 && (
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
                  {search.hits.map((h) => (
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

      {reading.length > 0 && (
        <div className="notice-strip" aria-label="Notices not yet on the board">
          <span className="muted small">Being read by AI, not on the board yet</span>
          {reading.map((n) => (
            <div key={n.id} className="notice-row">
              <FileText className="icon muted" aria-hidden />
              <span className="grow small">
                <b>{displayName(n.wholesaler ?? n.filename)}</b>{" "}
                <span className="muted" suppressHydrationWarning>
                  {n.wholesaler ? `· ${n.filename} ` : ""}· {relativeTime(n.createdAt)}
                </span>
              </span>
              <span className={`chip s-${n.status}`}>{STATUS_LABEL[n.status]}</span>
            </div>
          ))}
        </div>
      )}

      {triageShown.length > 0 && (
        <div className="notice-strip" aria-label="Notices that need triage">
          {triageShown.map((n) => (
            <TriageRow key={n.id} notice={n} canDismiss={planner} />
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        triageShown.length > 0 ? null : (
          <div className="lots">
            <div className="empty">
              <Inbox className="icon" style={{ width: 28, height: 28 }} aria-hidden />
              {rows.length === 0 ? (
                <>
                  <b>No lots yet.</b>
                  {guideHidden ? (
                    <button className="ghost" onClick={() => setGuideHidden(false)}>
                      Show the guide
                    </button>
                  ) : (
                    <span>Add a notice to start.</span>
                  )}
                </>
              ) : (
                <>
                  <b>Nothing here right now.</b>
                  <button className="ghost" onClick={() => chooseFilter("all")}>
                    Show all {counts.all}
                  </button>
                </>
              )}
            </div>
          </div>
        )
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
              onActed={() => setPinned((p) => new Set(p).add(l.id))}
              movedWhileOpen={movedByPolicy.has(l.id)}
              headRef={(el) => {
                if (el) headRefs.current.set(l.id, el);
                else headRefs.current.delete(l.id);
              }}
            />
          ))}
        </div>
      )}

      <p className="muted small" style={{ marginTop: 10 }}>
        {others.length ? `Also here: ${others.join(", ")}` : "No one else here right now."}
      </p>
    </div>
  );
}

/** A notice the pipeline could not turn into lots: why, and (planners, ops lead) a Dismiss with a short reason. */
function TriageRow({ notice: n, canDismiss }: { notice: Notice; canDismiss: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (asking) inputRef.current?.focus();
  }, [asking]);
  const reasonId = `dismiss-${n.id}`;

  const dismiss = async () => {
    const check = DismissReason.safeParse(reason);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "say why");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("noticeId", n.id);
    form.set("reason", check.data);
    try {
      const r = await dismissNoticeAction(idleState, form);
      if (!r.ok) setError(r.message ?? "could not dismiss");
      else router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notice-row triage-row" data-notice-id={n.id}>
      <FileText className="icon muted" aria-hidden />
      <span className="grow small">
        <b>{displayName(n.wholesaler ?? n.filename)}</b>{" "}
        <span className="muted" suppressHydrationWarning>
          {n.wholesaler ? `· ${n.filename} ` : ""}· {relativeTime(n.createdAt)}
        </span>
        <span className="reason">{triageReason(n.error)}</span>
      </span>
      <span className={`chip s-${n.status}`}>{STATUS_LABEL[n.status]}</span>
      {canDismiss && !asking && (
        <button type="button" className="small" onClick={() => setAsking(true)}>
          Dismiss
        </button>
      )}
      {asking && (
        <form
          className="dismiss-form"
          onSubmit={(e) => {
            e.preventDefault();
            void dismiss();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setAsking(false);
            }
          }}
        >
          <label className="sr-only" htmlFor={reasonId}>
            Reason for dismissing
          </label>
          <input
            ref={inputRef}
            id={reasonId}
            value={reason}
            maxLength={200}
            aria-required="true"
            placeholder="Why? e.g. marketing email"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${reasonId}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="primary small" disabled={busy}>
            {busy ? "Dismissing…" : "Confirm dismiss"}
          </button>
          <button type="button" className="ghost small" disabled={busy} onClick={() => setAsking(false)}>
            Cancel
          </button>
          {error && (
            <span id={`${reasonId}-error`} className="error small" role="alert">
              {error}
            </span>
          )}
        </form>
      )}
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
  onActed,
  headRef,
  movedWhileOpen,
}: {
  lot: Row;
  sites: Site[];
  me: User;
  open: boolean;
  onToggle: () => void;
  onActed: () => void;
  headRef: (el: HTMLButtonElement | null) => void;
  /** A policy save moved this lot to autopilot while this person had it open. */
  movedWhileOpen: boolean;
}) {
  const router = useRouter();
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const canPlan = plans(me.role);
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

  /** Runs a lot Server Action (take over, cancel, substitute review), then re-renders the board. */
  const act = async (action: (prev: FormState, form: FormData) => Promise<FormState>, fields: Record<string, string>, then?: (r: FormState) => void) => {
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.set("lotId", lot.id);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    try {
      const r = await action(idleState, form);
      if (!r.ok) {
        setMsg({ kind: "error", text: r.message ?? "that didn’t work" });
        return;
      }
      then?.(r);
      onActed();
      router.refresh();
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
  // Only while it still holds: a later take-over or cancel makes "moved by policy" stale.
  const r = lot.rerouted;
  const reroute = r && ((r.to === "autopilot" && lot.status === "reserved") || (r.to === "planner" && lot.status === "open")) ? r : null;
  const movedNotice = movedWhileOpen && reroute?.to === "autopilot";

  return (
    <article className="lot banded" data-class={lot.drug.drugClass} data-class-label={classLabel(lot.drug.drugClass)} data-open={open} data-flash={flash} data-lot-id={lot.id}>
      <button className="lot-head" ref={headRef} aria-expanded={open} aria-controls={bodyId} aria-keyshortcuts="o" onClick={onToggle}>
        <span className={`tier t${lot.drug.tier}`} title={TIER_HINT[lot.drug.tier] ?? `Clinical tier ${lot.drug.tier}`}>
          T{lot.drug.tier}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="name" style={{ display: "block" }}>
            {lot.drug.name}
          </span>
          <span className="sub" style={{ display: "block" }} suppressHydrationWarning>
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
        <span className="col-cover">{Number.isFinite(low) && <CoverBar days={low} label />}</span>
        <span style={{ justifySelf: "end" }}>
          <span className={`chip s-${lot.status}`} title={STATUS_HINT[lot.status]}>
            {STATUS_LABEL[lot.status]}
          </span>
        </span>
        <ChevronRight className="icon chev" aria-hidden />
      </button>

      {open && (
        <div className="lot-body" id={bodyId}>
          <p className="decision">
            <span>
              {classLabel(lot.drug.drugClass)} · ETA {lot.eta ?? "not stated"} · {lot.ruleId ? <code>{lot.ruleId}</code> : "no rule"} → {ACTION_LABEL[lot.action]}
              {lot.policyVersion !== null && <> (policy v{lot.policyVersion})</>}
            </span>
            {lot.hardFloor && (
              <span className="floor" title="Hard floor, set in code">
                <ShieldAlert className="icon" aria-hidden />
                {lot.hardFloor === "tier1" ? "Tier 1: a person commits" : "Substitute: pharmacist first"}
              </span>
            )}
            {reroute && !movedNotice && (
              <span className="badge-reroute">
                <ArrowRightLeft className="icon" aria-hidden />
                {reroute.to === "autopilot" ? "Moved to autopilot" : "Moved back to planners"} by policy v{reroute.policyVersion}
              </span>
            )}
          </p>
          {lot.status === "open" && canPlan && lot.action === "manual_only" && <p className="small next-step">Manual only: enter each quantity.</p>}
          {movedNotice && (
            <div className="callout warn small" role="status">
              Policy v{reroute.policyVersion} moved this lot to autopilot. Use Edit split to take it back.
            </div>
          )}

          {lot.status === "reserved" && (
            <AutopilotCallout
              lot={lot}
              siteName={siteName}
              canPlan={canPlan}
              busy={busy}
              onEdit={() => act(reservationAction, { mode: "takeover" }, (r) => setHandoff(r.allocations ?? null))}
              onCancel={() => act(reservationAction, { mode: "cancel" })}
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
                    <button className="primary" disabled={busy} onClick={() => act(substituteAction, { decision: "approved" })}>
                      <Check className="icon" aria-hidden /> Approve substitute
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => act(substituteAction, { decision: "rejected" })}>
                      Reject
                    </button>
                  </div>
                ) : null
              ) : (
                <p className="small">Pharmacist {lot.substitute.status} it.</p>
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
                router.refresh();
              }}
              onRebased={() => router.refresh()}
            />
          )}
          {!(lot.status === "open" && canPlan) && lot.status !== "committed" && <ProposalTable proposal={currentProposal(lot)} sites={sites} />}

          {commits.length > 0 && (
            <div className="commits">
              {commits.map(([key, rows]) => {
                const auto = rows[0]!.kind === "auto";
                const total = sumQuantity(rows);
                return (
                  <div key={key} className="commit">
                    <span>
                      <span className="actor">
                        {auto ? <Bot className="icon" aria-hidden /> : <UserRound className="icon" aria-hidden />}
                        {auto ? "Autopilot" : rows[0]!.actor}
                      </span>{" "}
                      <span className="muted" suppressHydrationWarning>
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

          <details className="why">
            <summary>Why this split?</summary>
            <div className="why-body">
              <p>{lot.explanation}</p>
              <p className="muted">
                {lot.ruleId ? (
                  <>
                    Rule <code>{lot.ruleId}</code>
                  </>
                ) : (
                  "No rule matched, so"
                )}{" "}
                {lot.policyVersion !== null ? `in policy v${lot.policyVersion} ` : ""}chose {ACTION_LABEL[lot.action]}.
                {lot.hardFloor === "tier1" && " Tier 1 is a hard floor: autopilot never commits it."}
                {lot.hardFloor === "substitute" && " Substitutes are a hard floor: a pharmacist reviews them first."}
                {reroute && (
                  <span suppressHydrationWarning>
                    {" "}
                    Policy v{reroute.policyVersion} moved it {reroute.to === "autopilot" ? "to autopilot" : "back to planners"} {relativeTime(reroute.at)}.
                  </span>
                )}
              </p>
              {lot.notice.confidence !== null && <p className="muted">Extraction confidence {Math.round(lot.notice.confidence * 100)}%.</p>}
              {lot.precedent && (
                <div className="precedent-note">
                  <span className="title">
                    <Sparkles className="icon" aria-hidden /> Precedent
                  </span>
                  <p>{lot.precedent.note}</p>
                  <p className="muted">AI-written from: {lot.precedent.sources.join(", ")}</p>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </article>
  );
}

/** The split as read-only rows (no editor: autopilot pending, waiting on a pharmacist, or a viewer who can't commit). */
function ProposalTable({ proposal, sites }: { proposal: Proposal; sites: Site[] }) {
  const lowest = lowestSite(proposal);
  const rows = sites.filter((s) => s.id in proposal.coverAfter);
  if (rows.length === 0) return null;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Cover after split</th>
            <th className="num">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={s.id === lowest ? "lowest" : undefined}>
              <td>
                {s.name}
                {s.id === lowest && <span className="low-tag">lowest</span>}
              </td>
              <td>
                <CoverBar days={proposal.coverAfter[s.id]!} label />
              </td>
              <td className="num">{fmt.format(proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The site left with the least cover after a split, to highlight in its table. */
const lowestSite = (p: Proposal) => Object.entries(p.coverAfter).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;

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
          <Bot className="icon" aria-hidden /> Autopilot commits in <span className="mono" suppressHydrationWarning>{left === null ? "–" : mmss(left)}</span>
        </span>
        <span className="small" style={{ display: "block" }}>
          {fmt.format(sumQuantity(split))} {lot.drug.unit}s to {split.length} sites
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

/** A lot's current split: the server's fresh split of what is left (it reflects every commit so far), else the stored one. */
const currentProposal = (lot: Lot): Proposal => lot.freshProposal ?? lot.proposal;

/**
 * propose: inputs start at the proposed split (one click to commit).
 * manual_only: inputs start empty; the proposal is shown for reference and the planner enters every quantity.
 * A take-over starts from the reserved autopilot split.
 * The commit is a Server Action form: `commitKey` is made once per form instance and renewed only after a commit
 * lands or the split is rebased, so a double submit is a replay, not a second commit.
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
  const [proposal, setProposal] = useState<Proposal>(() => currentProposal(lot));
  const [basis, setBasis] = useState(lot.remaining); // what was available when this split was computed
  const [values, setValues] = useState<Record<string, number>>({});
  const [commitKey, setCommitKey] = useState(() => crypto.randomUUID());
  const [banner, setBanner] = useState<{ kind: "error" | "warn"; text: string } | null>(null);
  const [state, formAction, busy] = useActionState(commitAction, idleState);
  const submitted = useRef("");
  // Committing ships scarce stock: one deliberate confirm, focused so Enter completes it from the keyboard.
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // Someone else committed while this editor was open (the live refresh brought new props): rebase onto what is
  // left and say why.
  // Keyed on the lot prop changing, not on `basis`: a lost race sets `basis` from the commit's reply before the refreshed
  // lot arrives, and comparing the two then would rebase onto the stale prop and replace the reply's banner and split.
  // After this editor's own commit lands, `ownLanded` holds what the reply said is left: the refresh that brings it is
  // our commit, so the split rebases without the "someone else committed" warning.
  const seenRemaining = useRef(lot.remaining);
  const ownLanded = useRef<number | null>(null);
  useEffect(() => {
    if (seenRemaining.current === lot.remaining) return;
    seenRemaining.current = lot.remaining;
    const ours = ownLanded.current === lot.remaining;
    ownLanded.current = null;
    if (lot.remaining === basis) return;
    if (!ours) {
      const who = lot.committed.at(-1)?.actor;
      setBanner({
        kind: "warn",
        text: `${who ?? "Another planner"} just committed part of this lot. ${fmt.format(lot.remaining)} ${lot.drug.unit}s are left; the split is updated.`,
      });
    }
    setBasis(lot.remaining);
    setProposal(currentProposal(lot));
    setConfirming(false);
    setCommitKey(crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot.remaining]);

  // The commit's outcome.
  const handled = useRef(state);
  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (state.ok) {
      ownLanded.current = state.available ?? null;
      onCommitted(submitted.current, state.commitKey ?? commitKey);
      setCommitKey(crypto.randomUUID());
    } else if (state.code === "conflict" && state.proposal && state.available !== undefined) {
      // An open lot's remaining only falls, so if a live refresh already brought less than the reply says, the props are
      // newer: keep them rather than step back to the reply's split (the effect above won't fire again for them).
      const newer = lot.remaining < state.available;
      const left = newer ? lot.remaining : state.available;
      setBanner({
        kind: "warn",
        text: `Someone else committed first. ${fmt.format(left)} ${lot.drug.unit}s are left; the split is updated.`,
      });
      setProposal(newer ? currentProposal(lot) : state.proposal);
      setBasis(left);
      setCommitKey(crypto.randomUUID());
      onRebased();
    } else if (state.ok === false) setBanner({ kind: "error", text: state.message ?? "commit failed" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const fromProposal = () => setValues(Object.fromEntries(proposal.allocations.map((a) => [a.siteId, a.quantity])));

  useEffect(() => {
    if (initial && lot.remaining === basis && sumQuantity(initial) <= lot.remaining) setValues(Object.fromEntries(initial.map((a) => [a.siteId, a.quantity])));
    else if (manual) setValues({});
    else fromProposal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, initial]);

  const allocations: Allocation[] = Object.entries(values)
    .filter(([, q]) => q > 0)
    .map(([siteId, quantity]) => ({ siteId, quantity }));
  const total = sumQuantity(allocations);
  const over = total > lot.remaining;
  const lowest = lowestSite(proposal);

  return (
    <form
      className="editor"
      action={formAction}
      onSubmit={() => {
        submitted.current = `Committed ${fmt.format(total)} ${lot.drug.unit}s to ${allocations.length} site${allocations.length === 1 ? "" : "s"}.`;
        setBanner(null);
        setConfirming(false);
      }}
    >
      <input type="hidden" name="lotId" value={lot.id} />
      <input type="hidden" name="commitKey" value={commitKey} />
      {banner && (
        <div className={`callout ${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
          {banner.text}
        </div>
      )}
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
                <tr key={s.id} className={s.id === lowest ? "lowest" : undefined}>
                  <td>
                    {s.name}
                    {s.id === lowest && <span className="low-tag">lowest</span>}
                  </td>
                  <td className="num hide-sm">{s.acuity}</td>
                  <td>{s.id in proposal.coverAfter ? <CoverBar days={proposal.coverAfter[s.id]!} label /> : "–"}</td>
                  <td className="num muted hide-sm">{fmt.format(proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0)}</td>
                  <td className="num">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      name={`qty:${s.id}`}
                      placeholder={String(proposal.allocations.find((a) => a.siteId === s.id)?.quantity ?? 0)}
                      aria-label={`Allocation for ${s.name}`}
                      value={values[s.id] ?? ""}
                      onKeyDown={(e) => {
                        // Only the confirm button commits; Enter in a quantity never submits the form.
                        if (e.key === "Enter") e.preventDefault();
                      }}
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
            </>
          )}
        </p>
        <span className="row gap">
          {manual && (
            <button type="button" className="ghost" disabled={busy} onClick={fromProposal}>
              Copy proposal
            </button>
          )}
          {!confirming && (
            <button type="button" className="primary" disabled={busy || total === 0 || over} onClick={() => setConfirming(true)}>
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
          <span className="title" id={`confirm-${lot.id}`}>
            Commit {fmt.format(total)} {lot.drug.unit}s of {lot.drug.name} to {allocations.length} site{allocations.length === 1 ? "" : "s"}?
          </span>
          <span className="row gap">
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Back to editing
            </button>
            <button type="submit" className="primary" ref={confirmRef} disabled={busy}>
              {busy ? "Committing…" : "Confirm commit"}
            </button>
          </span>
        </div>
      )}
    </form>
  );
}
