"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { signInAction } from "../_lib/actions";

const TABS: [href: string, label: string, about: string][] = [
  ["/app", "Board", "Each notice becomes lots with a proposed split across the hospitals. Review a split, then commit it."],
  ["/app/intake", "New notice", ""],
  [
    "/app/policy",
    "Autopilot policy",
    "Rules that decide which lots commit on their own and which wait for a person. Hard floors in code can't be overridden.",
  ],
  ["/app/audit", "Audit trail", "Every change: who made it, when, and what it was."],
  ["/app/metrics", "Metrics", "How much stock went out, auto vs manual, and which sites are lowest on stock."],
];

export function TabNav({ needsMe }: { needsMe: number }) {
  const path = usePathname();
  const about = TABS.find(([href]) => href === path)?.[2];
  return (
    <>
      <nav className="tabs" aria-label="Sections">
        {TABS.map(([href, label]) => (
          <Link key={href} href={href} prefetch={false} aria-current={path === href ? "page" : undefined}>
            {label}
            {href === "/app" && needsMe > 0 && (
              <span className="tab-count" aria-label={`${needsMe} need you`}>
                {needsMe}
              </span>
            )}
          </Link>
        ))}
      </nav>
      {about && <p className="tab-about">{about}</p>}
    </>
  );
}

/** Old SPA links were /app#intake etc.; send them to the matching route. */
export function HashRedirect() {
  const router = useRouter();
  useEffect(() => {
    const tab = location.hash.slice(1);
    if (["intake", "policy", "audit", "metrics"].includes(tab)) router.replace(`/app/${tab}`);
  }, [router]);
  return null;
}

/**
 * The one live-update path: a WebSocket to BoardDO (through /api, which skips Next), and on any event a 150 ms
 * debounced `router.refresh()` that re-renders the current page on the server. Client state (open lots, editors in
 * progress) survives the refresh. Reconnects with backoff (2 s, up to 30 s), and refreshes after a reconnect in case events were missed.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let everOpen = false;
    let retry: number | undefined;
    let failures = 0;
    let openedAt = 0;
    let ping: number | undefined;
    let debounce: number | undefined;
    const refresh = () => routerRef.current.refresh();
    const connect = () => {
      const url = new URL("/api/board/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      ws.onopen = () => {
        openedAt = Date.now();
        setLive(true);
        if (everOpen) refresh();
        everOpen = true;
        ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        window.clearTimeout(debounce);
        debounce = window.setTimeout(refresh, 150);
      };
      ws.onclose = () => {
        setLive(false);
        window.clearInterval(ping);
        // Back off (2 s doubling to 30 s) so a tab whose socket is refused doesn't hammer the Worker all day. Only a
        // connection that stayed up for a while resets it: one that opens and is dropped at once keeps backing off.
        if (openedAt && Date.now() - openedAt > 10_000) failures = 0;
        openedAt = 0;
        if (!closed) retry = window.setTimeout(connect, Math.min(30_000, 2000 * 2 ** failures++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(debounce);
      window.clearInterval(ping);
      ws?.close();
    };
  }, []);

  return (
    <span className="live" data-on={live} role="status" title="The board updates in real time as other people act.">
      <span className="dot" aria-hidden />
      {live ? "Live" : "Reconnecting…"}
    </span>
  );
}

/** Switches demo persona through the sign-in Server Action (it re-sets the cookie), then re-renders the page. */
export function PersonaSwitcher({ me, options }: { me: string; options: { email: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="row gap">
      <span className="viewing-as">Viewing as</span>
      <select
        value={me}
        disabled={pending}
        aria-describedby={error ? "persona-error" : undefined}
        onChange={(e) => {
          const form = new FormData();
          form.set("email", e.target.value);
          start(async () => {
            const r = await signInAction({ ok: null }, form);
            setError(r.ok ? null : (r.message ?? "could not switch persona"));
            router.refresh();
          });
        }}
      >
        {options.map((o) => (
          <option key={o.email} value={o.email}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <span id="persona-error" className="sr-only" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
