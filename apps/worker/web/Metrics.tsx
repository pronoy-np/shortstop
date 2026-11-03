import { useEffect, useState } from "react";
import { api, identity } from "./api";

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
  if (!m) return <div className="panel muted">Loading metrics…</div>;

  const auto = m.units.find((u) => u.kind === "auto");
  const manual = m.units.find((u) => u.kind === "manual");
  const totalUnits = (auto?.units ?? 0) + (manual?.units ?? 0);
  const as = identity.get();

  return (
    <div className="stack">
      <div className="tiles">
        <Tile label="Notices" value={count(m.notices)} detail={m.notices.map((r) => `${r.n} ${r.status.replace("_", " ")}`).join(" · ")} />
        <Tile label="Lots" value={count(m.lots)} detail={m.lots.map((r) => `${r.n} ${r.status.replace("_", " ")}`).join(" · ")} />
        <Tile
          label="Units allocated by autopilot"
          value={totalUnits ? `${Math.round(((auto?.units ?? 0) / totalUnits) * 100)}%` : "–"}
          detail={`${auto?.units ?? 0} auto · ${manual?.units ?? 0} by planners`}
        />
        <Tile label="Autopilot overrides" value={count(m.overrides)} detail={m.overrides.map((r) => `${r.n} ${r.action.replace("lot.", "").replace("_", " ")}`).join(" · ") || "none"} />
        <Tile label="Avg time to first commit" value={m.avgMinutesToFirstCommit ? `${m.avgMinutesToFirstCommit.toFixed(1)} min` : "–"} detail="from lot planned to first allocation" />
        <Tile label="Dead letters" value={m.deadLetters} detail="intake messages that exhausted retries" />
      </div>

      <section className="panel">
        <div className="row between wrap">
          <h2>Lowest days of cover in the network</h2>
          <span className="muted small">Snapshot {new Date(m.cover.generatedAt).toLocaleString()} (nightly cron)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Drug</th>
              <th className="num">Tier</th>
              <th className="num">Days of cover</th>
            </tr>
          </thead>
          <tbody>
            {m.cover.lowest.map((r, i) => (
              <tr key={i}>
                <td>{r.siteName}</td>
                <td>{r.drugName}</td>
                <td className="num">{r.tier}</td>
                <td className={`num ${r.cover < 5 ? "error" : ""}`}>{r.cover}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small">
          <a className="link" href={`/api/export/allocations.csv${as ? `?as=${encodeURIComponent(as)}` : ""}`}>
            Export all allocations (CSV)
          </a>
        </p>
      </section>
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="panel tile">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
      <div className="muted small">{detail}</div>
    </div>
  );
}
