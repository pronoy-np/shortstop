import { ArrowRight } from "lucide-react";
import { Logo } from "./Logo";

// A static, honest preview of the desk: the same components and numbers shape the product uses.
const PREVIEW: [site: string, acuity: number, cover: number, qty: number][] = [
  ["Riverbend Cancer Institute", 1, 14.0, 41],
  ["Riverbend University Medical Center", 1, 11.9, 28],
  ["St. Clare Regional", 2, 8.6, 16],
  ["Prairie Medical Center", 2, 7.9, 9],
  ["Oakford Family Hospital", 3, 4.2, 6],
];

function Bar({ days }: { days: number }) {
  return (
    <span className="cover">
      <span className="cover-track" aria-hidden>
        <span className={`cover-fill ${days < 5 ? "low" : ""}`} style={{ ["--w" as string]: `${Math.min(100, (days / 30) * 100)}%` }} />
        <span className="cover-floor" style={{ ["--floor" as string]: `${(5 / 30) * 100}%` }} />
      </span>
      <span className="cover-val">{days}d</span>
    </span>
  );
}

export function Landing() {
  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="inner">
          <div className="shell-top">
            <a className="brand" href="/" aria-label="ShortStop home">
              <Logo />
              <span className="brand-name">ShortStop</span>
            </a>
            <a className="button ghost" href="/app" style={{ color: "var(--shell-ink)", borderColor: "var(--shell-2)" }}>
              Sign in to the desk
            </a>
          </div>

          <div className="grid">
            <div>
              <h1>Every scarce vial, to the hospital that needs it most.</h1>
              <p className="lede">
                ShortStop reads wholesaler allocation notices, proposes a fair split across your network by days of cover, and lets planners commit
                it without ever over-allocating a lot.
              </p>
              <div className="cta">
                <a className="button primary" href="/app">
                  Try the live demo <ArrowRight className="icon" aria-hidden />
                </a>
                <span className="note">Synthetic data · pick a persona once inside</span>
              </div>
            </div>

            <figure className="preview" aria-label="Preview of a cisplatin lot on the ShortStop desk" style={{ margin: 0 }}>
              <div className="preview-head">
                <span className="tier t1">T1</span>
                <span className="grow">
                  <b>Cisplatin 1 mg/mL injection 50 mL</b>
                  <span className="muted small" style={{ display: "block" }}>
                    Northstar Specialty · NS-CIS-1103 · 100 of 150 vials left
                  </span>
                </span>
                <span className="chip s-open">Awaiting planner</span>
              </div>
              <div className="callout warn small" role="presentation">
                Marcus just committed 50 vials. 100 are left, and your split has been rebased to match.
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Cover after split</th>
                    <th className="num">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {PREVIEW.map(([site, , cover, qty]) => (
                    <tr key={site}>
                      <td className="small">{site}</td>
                      <td>
                        <Bar days={cover} />
                      </td>
                      <td className="num">{qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="preview-foot">
                <span className="small muted">
                  <b style={{ color: "var(--ink)" }}>100</b> vials to 5 sites · lowest cover Oakford 4.2d
                </span>
                <span className="button primary" style={{ minHeight: 34, padding: "0 12px", borderRadius: 6, fontSize: 13 }}>
                  Commit 100 vials
                </span>
              </div>
            </figure>
          </div>
        </div>
      </section>

      <section className="flow" aria-label="How a notice moves through the desk">
        <div className="flow-step">
          <span className="n">01</span>
          <h2>The notice is read for you</h2>
          <p>PDF, email or pasted text. Workers AI pulls out the allocated quantities and ETAs, and anything that isn’t a notice goes to triage, not to a guess.</p>
        </div>
        <div className="flow-step">
          <span className="n">02</span>
          <h2>A split you can defend</h2>
          <p>Days of cover are evened out across ten hospitals, weighted toward ICU and oncology. Plain arithmetic: the same notice always gets the same answer.</p>
        </div>
        <div className="flow-step">
          <span className="n">03</span>
          <h2>One commit wins</h2>
          <p>Two planners on the same lot at the same moment: exactly one commit lands, and the other sees what’s left, rebased, before anyone ships a vial.</p>
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
