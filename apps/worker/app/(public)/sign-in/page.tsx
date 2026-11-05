import Link from "next/link";
import { listDemoUsers } from "../../../src/services/users";
import { Logo } from "../../_components/logo";
import { roleLabel } from "../../_lib/format";
import { currentUser, workerEnv } from "../../_lib/server";
import { PersonaButton } from "./persona-button";

export const dynamic = "force-dynamic";

const ROLE_HINT = {
  planner: "Commits splits and submits notices.",
  pharmacist: "Reviews therapeutic substitutes.",
  ops_lead: "Everything a planner does, plus the autopilot policy.",
} as const;

/** Demo persona picker. Only while Cloudflare Access is off; with Access on, Access signs people in before they get here. */
export default async function SignIn() {
  const me = await currentUser();
  const { users, demo } = await listDemoUsers(await workerEnv());
  return (
    <main className="content" style={{ maxWidth: 640, paddingTop: 40 }}>
      <section className="panel stack">
        <Link className="brand" href="/" aria-label="ShortStop home" style={{ color: "var(--ink)" }}>
          <Logo />
          <span className="brand-name">ShortStop</span>
        </Link>
        <h1 style={{ fontSize: 22, margin: 0 }}>Sign in to the desk</h1>
        {demo ? (
          <>
            <p className="muted small">
              This is a demo with synthetic data. Pick a fictional persona; you can switch at any time from the top of the desk.
              {me.ok ? ` You are signed in as ${me.user.name}.` : ""}
            </p>
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {users.map((u) => (
                <li key={u.email}>
                  <PersonaButton email={u.email} label={`${u.name} · ${roleLabel[u.role]}`} hint={ROLE_HINT[u.role]} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="callout warn small" role="status">
            Demo sign-in is off. ShortStop accounts sign in with Cloudflare Access; open <Link href="/app" prefetch={false}>the desk</Link> to
            continue.
          </div>
        )}
      </section>
    </main>
  );
}
