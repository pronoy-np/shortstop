import { useEffect, useState } from "react";
import { STATUS_LABEL, api, fmt, identity, relativeTime } from "./api";

type Metrics = {
  notices: { status: string; n: number }[];
  lots: { status: string; n: number }[];
  units: { kind: string; units: number; lots: number }[];
  overrides: { action: string; n: number }[];
  avgMinutesToFirstCommit: number;
  deadLetters: number;
  cover: { generatedAt: number; lowest: { siteName: string; drugName: string; tier: number; cover: number }[] };
};

const count = (rows: { n: number }[]) => rows.reduce((s, r) => s + r.n, 0);

export function MetricsView({ tick }: { tick: number }) {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    api<Metrics>("/metrics").then(setM);
  }, [tick]);
  if (!m) return <p className="muted" role="status">Loading metrics…</p>;

  const auto = m.units.find((u) => u.kind === "auto");
  const manual = m.units.find((u) => u.kind === "manual");
  const totalUnits = (auto?.units ?? 0) + (manual?.units ?? 0);
  const as = identity.get();
  const list = (rows: { n: number; status: string }[]) => rows.map((r) => `${r.n} ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status}`).join(" · ");

  return (
    <div className="stack">
      <section className="panel" style={{ padding: 0 }} aria-label="Desk totals">
        <dl className="stats" style={{ margin: 0 }}>
          <Stat label="Notices" value={fmt.format(count(m.notices))} detail={list(m.notices)} />
          <Stat label="Lots" value={fmt.format(count(m.lots))} detail={list(m.lots)} />
          <Stat
            label="Units by autopilot"
            value={totalUnits ? `${Math.round(((auto?.units ?? 0) / totalUnits) * 100)}%` : "–"}
            detail={`${fmt.format(auto?.units ?? 0)} auto · ${fmt.format(manual?.units ?? 0)} by planners`}
          />
          <Stat
            label="Autopilot overridden"
            value={fmt.format(count(m.overrides))}
            detail={m.overrides.map((r) => `${r.n} ${r.action === "lot.taken_over" ? "taken over" : "cancelled"}`).join(" · ") || "none yet"}
          />
          <Stat label="Time to first commit" value={m.avgMinutesToFirstCommit ? `${m.avgMinutesToFirstCommit.toFixed(1)} min` : "–"} detail="average, from planned to first allocation" />
          <Stat label="Dead letters" value={fmt.format(m.deadLetters)} detail="intake that ran out of retries" />
        </dl>
      </section>

      <section className="panel stack">
        <div className="row between wrap">
          <h2>Lowest days of cover in the network</h2>
          <span className="muted small" title={new Date(m.cover.generatedAt).toISOString()}>
            Snapshot {relativeTime(m.cover.generatedAt)} · refreshed nightly
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Drug</th>
                <th className="num">Tier</th>
                <th>Days of cover</th>
              </tr>
            </thead>
            <tbody>
              {m.cover.lowest.map((r, i) => (
                <tr key={i}>
                  <td>{r.siteName}</td>
                  <td>{r.drugName}</td>
                  <td className="num">
                    <span className={`tier t${r.tier}`}>T{r.tier}</span>
                  </td>
                  <td>
                    <span className="cover">
                      <span className="cover-track" aria-hidden>
                        <span className={`cover-fill ${r.cover < 5 ? "low" : ""}`} style={{ ["--w" as string]: `${Math.min(100, (r.cover / 30) * 100)}%` }} />
                        <span className="cover-floor" style={{ ["--floor" as string]: `${(5 / 30) * 100}%` }} />
                      </span>
                      <span className={`cover-val ${r.cover < 5 ? "error" : ""}`}>{r.cover}d</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          <a href={`/api/export/allocations.csv${as ? `?as=${encodeURIComponent(as)}` : ""}`}>Export every allocation as CSV</a>
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      <div className="detail">{detail}</div>
    </div>
  );
}
