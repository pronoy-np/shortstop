import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, boardSocketUrl, identity, needsMe, roleLabel, type Board, type User } from "./api";
import { AuditView } from "./Audit";
import { BoardView } from "./Board";
import { IntakeView } from "./Intake";
import { Logo } from "./Logo";
import { MetricsView } from "./Metrics";
import { PolicyView } from "./Policy";

type Tab = "board" | "intake" | "policy" | "audit" | "metrics";
const TABS: [Tab, string][] = [
  ["board", "Board"],
  ["intake", "New notice"],
  ["policy", "Autopilot policy"],
  ["audit", "Audit trail"],
  ["metrics", "Metrics"],
];

// The tab lives in the URL hash so reloads and shared links land on the same view.
const tabFromHash = (): Tab => {
  const h = location.hash.replace("#", "");
  return TABS.some(([id]) => id === h) ? (h as Tab) : "board";
};

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [demoUsers, setDemoUsers] = useState<User[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [board, setBoard] = useState<Board | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0); // bumps on any live event so other views can refetch
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const mainRef = useRef<HTMLElement>(null);

  const setTab = useCallback((t: Tab, focusMain = false) => {
    setTabState(t);
    history.replaceState(null, "", `#${t}`);
    if (focusMain) mainRef.current?.focus();
  }, []);

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<User>("/me"));
      setAuthError(null);
    } catch (e) {
      setMe(null);
      setAuthError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    api<{ users: User[]; demo: boolean }>("/users")
      .then(({ users, demo }) => {
        setDemoUsers(users);
        if (demo && !identity.get() && users[0]) identity.set(users[0].email);
      })
      .finally(loadMe);
  }, [loadMe]);

  const refresh = useCallback(async () => {
    try {
      setBoard(await api<Board>("/board"));
    } catch {
      // auth errors surface via loadMe
    }
  }, []);

  useEffect(() => {
    if (me) void refresh();
  }, [me, refresh]);

  // Live board: one WebSocket to BoardDO; any event triggers a debounced refetch.
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!me) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    let ping: number | undefined;
    const connect = () => {
      ws = new WebSocket(boardSocketUrl());
      ws.onopen = () => {
        setLive(true);
        void refresh();
        ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          void refresh();
          setTick((t) => t + 1);
        }, 150);
      };
      ws.onclose = () => {
        setLive(false);
        window.clearInterval(ping);
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(ping);
      ws?.close();
    };
  }, [me, refresh]);

  const switchUser = (email: string) => {
    identity.set(email);
    void loadMe();
  };

  // Roving tabindex + arrow keys, per the ARIA tabs pattern.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length]![0];
    setTab(t);
    tabRefs.current[t]?.focus();
  };

  const myQueue = me && board ? board.notices.flatMap((n) => n.lots).filter((l) => needsMe(l, me.role)).length : 0;

  return (
    <>
      <header className="shell-header">
        <div className="inner">
          <div className="shell-top">
            <a className="brand" href="/" aria-label="ShortStop home">
              <Logo />
              <span>
                <span className="brand-name">ShortStop</span> <span className="brand-sub">Riverbend Health · central pharmacy</span>
              </span>
            </a>
            <div className="who">
              <span className="live" data-on={live} role="status">
                <span className="dot" aria-hidden />
                {live ? "Live" : "Reconnecting…"}
              </span>
              {demoUsers.length > 0 && (
                <span className="demo-pill" title="Fictional personas and synthetic data. Real accounts sign in with Cloudflare Access.">
                  Demo
                </span>
              )}
              {demoUsers.length > 0 ? (
                <label>
                  <span className="sr-only">Signed in as</span>
                  <select value={me?.email ?? ""} onChange={(e) => switchUser(e.target.value)}>
                    {demoUsers.map((u) => (
                      <option key={u.email} value={u.email}>
                        {u.name} · {roleLabel[u.role]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : me ? (
                <span>
                  {me.name} · {roleLabel[me.role]}
                </span>
              ) : null}
            </div>
          </div>
          <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onTabKey}>
            {TABS.map(([id, label]) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls="panel"
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
              >
                {label}
                {id === "board" && myQueue > 0 && (
                  <span className="tab-count" aria-label={`${myQueue} need you`}>
                    {myQueue}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="content" id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1} ref={mainRef}>
        {authError && !me ? (
          <div className="callout error" role="alert">
            Not signed in: {authError}
          </div>
        ) : !me ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : tab === "board" ? (
          <BoardView me={me} board={board} onChange={refresh} />
        ) : tab === "intake" ? (
          <IntakeView me={me} onSubmitted={() => setTab("board", true)} />
        ) : tab === "policy" ? (
          <PolicyView me={me} tick={tick} />
        ) : tab === "audit" ? (
          <AuditView tick={tick} />
        ) : (
          <MetricsView tick={tick} />
        )}
      </main>
    </>
  );
}
