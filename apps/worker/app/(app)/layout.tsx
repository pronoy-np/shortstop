import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { countNeedsMe, listDemoUsers } from "../../src/services/users";
import { Logo } from "../_components/logo";
import { roleLabel } from "../_lib/format";
import { currentUser, workerEnv } from "../_lib/server";
import { HashRedirect, LiveRefresh, PersonaSwitcher, TabNav } from "./desk-client";

export const dynamic = "force-dynamic";

/** The desk shell. Gate: nobody signed in → /sign-in; a known identity that isn't a ShortStop user → 403 message. */
export default async function DeskLayout({ children }: { children: ReactNode }) {
  const me = await currentUser();
  if (!me.ok && me.code === "unauthenticated") redirect("/sign-in");
  if (!me.ok)
    return (
      <main className="content" style={{ paddingTop: 40 }}>
        <div className="callout error" role="alert">
          <span className="title">You can’t use this desk.</span>
          <p className="small">{me.message}</p>
          <p className="small">
            <Link href="/sign-in" prefetch={false}>
              Sign in as someone else
            </Link>
          </p>
        </div>
      </main>
    );

  const env = await workerEnv();
  const [{ users }, needs] = await Promise.all([listDemoUsers(env), countNeedsMe(env, me.user.role)]);

  return (
    <>
      <HashRedirect />
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
              <LiveRefresh />
              {users.length > 0 && (
                <span className="demo-pill" title="Fictional personas and synthetic data. Real accounts sign in with Cloudflare Access.">
                  Demo · synthetic data
                </span>
              )}
              {users.length > 0 ? (
                <PersonaSwitcher me={me.user.email} options={users.map((u) => ({ email: u.email, label: `${u.name} · ${roleLabel[u.role]}` }))} />
              ) : (
                <span>
                  {me.user.name} · {roleLabel[me.user.role]}
                </span>
              )}
            </div>
          </div>
          <TabNav needsMe={needs} />
        </div>
      </header>
      <main className="content" id="panel" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
