import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LaunchFilm } from "../_components/launch-film";
import { Logo } from "../_components/logo";

// Prerendered at build time and served from the static-assets cache (ADR 0001). No bindings or request APIs here.
export const dynamic = "force-static";

export default function Landing() {
  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="inner">
          <div className="shell-top">
            <a className="brand" href="/" aria-label="ShortStop home">
              <Logo />
              <span className="brand-name">ShortStop</span>
            </a>
            <Link className="button ghost" href="/sign-in" prefetch={false} style={{ color: "var(--shell-ink)", borderColor: "var(--shell-2)" }}>
              Sign in to the desk
            </Link>
          </div>

          <div className="grid">
            <div>
              <h1>Every scarce vial, to the hospital that needs it most.</h1>
              <p className="lede">
                ShortStop reads wholesaler allocation notices, proposes a fair split across your network by days of cover, and lets planners commit
                it without ever over-allocating a lot.
              </p>
              <div className="cta">
                <Link className="button primary" href="/app" prefetch={false}>
                  Try the live demo <ArrowRight className="icon" aria-hidden />
                </Link>
                <span className="note">Synthetic data · pick a persona once inside</span>
              </div>
            </div>

            <LaunchFilm />
          </div>
        </div>
      </section>

      <section className="flow" aria-label="How a notice moves through the desk">
        <div className="flow-step">
          <h2>The notice is read for you</h2>
          <p>PDF, email or pasted text. Workers AI pulls out the allocated quantities and ETAs, and anything that isn’t a notice goes to triage, not to a guess.</p>
        </div>
        <div className="flow-step">
          <h2>A split you can defend</h2>
          <p>Days of cover are evened out across ten hospitals, weighted toward ICU and oncology. Plain arithmetic: the same notice always gets the same answer.</p>
        </div>
        <div className="flow-step">
          <h2>One commit wins</h2>
          <p>Two planners on the same lot at the same moment: exactly one commit lands, and the other sees the split updated to what’s left before anyone ships a vial.</p>
        </div>
      </section>

      <section className="floors">
        <div className="band">
          <h2>Autopilot, with floors it can’t cross.</h2>
          <p>
            Your ops lead decides what commits on its own, with a 15-minute window to cancel. Tier-1 drugs and any therapeutic substitute always
            wait for a person, and that rule lives in code, not in a setting. Every automatic commit records the rule and policy version that fired it.
          </p>
        </div>
      </section>

      <footer className="landing-foot">
        <span>ShortStop · a Project JEDI build for Riverbend Health</span>
        <span>All hospitals, stock and people in the demo are fictional.</span>
      </footer>
    </div>
  );
}
