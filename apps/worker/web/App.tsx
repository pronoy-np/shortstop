import { useCallback, useEffect, useRef, useState } from "react";
import { api, boardSocketUrl, identity, roleLabel, type Board, type User } from "./api";
import { AuditView } from "./Audit";
import { BoardView } from "./Board";
import { IntakeView } from "./Intake";
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

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [demoUsers, setDemoUsers] = useState<User[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("board");
  const [board, setBoard] = useState<Board | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0); // bumps on any live event so other views can refetch

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

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▮▯
          </span>
          <div>
            <strong>ShortStop</strong>
            <span className="muted"> · Riverbend Health central pharmacy</span>
          </div>
        </div>
        <div className="who">
          <span className={`dot ${live ? "on" : ""}`} title={live ? "Live updates connected" : "Reconnecting"} />
          {demoUsers.length > 0 ? (
            <label className="switcher">
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
      </header>

      <nav className="tabs" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {demoUsers.length > 0 && (
        <div className="demo-banner small" role="note">
          Demo mode: switch between the fictional personas above to try each role. Data is synthetic. Real accounts sign in
          with Cloudflare Access.
        </div>
      )}

      <main>
        {authError && !me ? (
          <div className="panel error">Not signed in: {authError}</div>
        ) : !me ? (
          <div className="panel muted">Loading…</div>
        ) : tab === "board" ? (
          <BoardView me={me} board={board} onChange={refresh} />
        ) : tab === "intake" ? (
          <IntakeView me={me} onSubmitted={() => setTab("board")} />
        ) : tab === "policy" ? (
          <PolicyView me={me} tick={tick} />
        ) : tab === "audit" ? (
          <AuditView tick={tick} />
        ) : (
          <MetricsView tick={tick} />
        )}
      </main>
    </div>
  );
}
