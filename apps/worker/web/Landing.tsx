/** Public landing page at "/". The desk itself lives at /app. */
export function Landing() {
  return (
    <div className="shell landing">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▮▯
          </span>
          <strong>ShortStop</strong>
        </div>
        <a className="button primary" href="/app">
          Open the desk
        </a>
      </header>

      <section className="hero">
        <h1>When a drug is short, every vial has to go to the right hospital.</h1>
        <p className="lede">
          ShortStop is an allocation desk for a health system’s central pharmacy. Wholesaler notices come in as PDFs, emails or text; AI reads
          them, a deterministic engine proposes a fair split across ten hospitals, and planners commit it, without ever over-allocating a scarce
          lot.
        </p>
        <a className="button primary" href="/app">
          Try the demo
        </a>
        <p className="muted small">Demo data is synthetic. Pick a persona at the top right to play planner, pharmacist or ops lead.</p>
      </section>

      <section className="features">
        <div className="panel">
          <h3>AI reads the mess</h3>
          <p className="small">Workers AI turns allocation letters, .eml threads and PDFs into structured lots, and refuses anything that isn’t a notice.</p>
        </div>
        <div className="panel">
          <h3>Splits you can defend</h3>
          <p className="small">Days of cover are evened out across sites, weighted by acuity. Plain TypeScript, so the same input gives the same answer.</p>
        </div>
        <div className="panel">
          <h3>Autopilot, with hard floors</h3>
          <p className="small">Ops leads choose what auto-commits. Tier-1 drugs and substitutes always need a human, enforced in code.</p>
        </div>
        <div className="panel">
          <h3>The contested write</h3>
          <p className="small">
            Two planners commit the same scarce lot at the same moment: a Durable Object lets exactly one win and hands the other a fresh split of
            what’s left.
          </p>
        </div>
      </section>

      <footer className="muted small">Built on Cloudflare Workers, D1, KV, R2, Durable Objects, Queues, Workflows, Workers AI, Vectorize and Cron, at $0.</footer>
    </div>
  );
}
