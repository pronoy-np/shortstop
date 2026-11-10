import { Download, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { DAILY_DAYS, loadMetrics } from "../../../../src/services/metrics";
import { fmt, relativeTime } from "../../../_lib/format";
import { workerEnv } from "../../../_lib/server";
import { CoverRankChart } from "./cover-rank-chart";
import { DailyUnitsChart, type Day } from "./daily-units-chart";

const DAY_MS = 86_400_000;
const count = (rows: { n: number }[]) => rows.reduce((s, r) => s + r.n, 0);
const plural = (n: number, word: string) => `${fmt.format(n)} ${word}${n === 1 ? "" : "s"}`;
const pctOf = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

function duration(min: number): string {
  if (min < 1) return "< 1 min";
  if (min < 90) return `${min.toFixed(min < 10 ? 1 : 0)} min`;
  if (min < 48 * 60) return `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
  return `${(min / 1440).toFixed(1)} d`;
}

/** Desk metrics for the ops lead: a pure Server Component (no client JS, charts are server-rendered SVG). */
export default async function MetricsPage() {
  const now = Date.now();
  const m = await loadMetrics(await workerEnv(), now);

  const autoUnits = m.units.find((u) => u.kind === "auto")?.units ?? 0;
  const manualUnits = m.units.find((u) => u.kind === "manual")?.units ?? 0;
  const autoLots = m.units.find((u) => u.kind === "auto")?.lots ?? 0;
  const totalUnits = autoUnits + manualUnits;
  const cancels = m.overrides.find((o) => o.action === "lot.reservation_cancelled")?.n ?? 0;
  const takeovers = m.overrides.find((o) => o.action === "lot.taken_over")?.n ?? 0;
  const triage = m.notices.find((n) => n.status === "needs_triage")?.n ?? 0;
  const failed = m.notices.find((n) => n.status === "failed")?.n ?? 0;
  const needPerson = triage + failed;

  // The last DAILY_DAYS UTC days, oldest first, with empty days filled in.
  const first = Math.floor(now / DAY_MS) * DAY_MS - (DAILY_DAYS - 1) * DAY_MS;
  const days: Day[] = Array.from({ length: DAILY_DAYS }, (_, i) => {
    const at = new Date(first + i * DAY_MS);
    const day = at.toISOString().slice(0, 10);
    const rows = m.daily.filter((r) => r.day === day);
    return {
      day,
      label: at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      auto: rows.find((r) => r.kind === "auto")?.units ?? 0,
      manual: rows.find((r) => r.kind === "manual")?.units ?? 0,
    };
  });
  const anyDaily = days.some((d) => d.auto + d.manual > 0);
  const lowest = m.cover.lowest.slice(0, 10);

  return (
    <div className="stack metrics">
      <div className="metrics-bar">
        <p className="metrics-totals">
          {plural(count(m.notices), "notice")} · {plural(count(m.lots), "lot")} · {plural(totalUnits, "unit")} committed
        </p>
        <a className="button secondary" href="/api/export/allocations.csv" download>
          <Download className="icon" aria-hidden /> Export allocations (CSV)
        </a>
      </div>

      <section className="kpis" aria-label="Key numbers">
        <Kpi label="Units committed by autopilot" value={totalUnits ? `${pctOf(autoUnits, totalUnits)}%` : "–"}>
          {totalUnits ? (
            <>
              <span className="split" aria-hidden>
                {autoUnits > 0 && <span className="auto" style={{ flexGrow: autoUnits }} />}
                {manualUnits > 0 && <span className="manual" style={{ flexGrow: manualUnits }} />}
              </span>
              {fmt.format(autoUnits)} of {plural(totalUnits, "unit")} · {plural(autoLots, "lot")}
            </>
          ) : (
            "Shows once the first lot is committed"
          )}
        </Kpi>
        <Kpi label="Autopilot overrides" value={fmt.format(cancels + takeovers)}>
          {cancels + takeovers ? `${fmt.format(cancels)} cancelled · ${fmt.format(takeovers)} taken over` : "No cancels or take-overs yet"}
        </Kpi>
        <Kpi label="Average time to first commit" value={m.avgMinutesToFirstCommit ? duration(m.avgMinutesToFirstCommit) : "–"}>
          {m.avgMinutesToFirstCommit ? "From a lot being planned to its first allocation" : "Shows once the first lot is committed"}
        </Kpi>
        <Kpi
          label="Notices needing a person"
          value={fmt.format(needPerson)}
          flag={needPerson > 0 ? <TriangleAlert className="icon" aria-label="Needs attention" /> : null}
        >
          {fmt.format(triage)} to triage · {fmt.format(failed)} failed · {plural(m.deadLetters, "dead letter")}
        </Kpi>
      </section>

      <section className="panel">
        {anyDaily ? (
          <DailyUnitsChart days={days} />
        ) : (
          <Empty title="Units committed per day">
            Nothing committed in the last {DAILY_DAYS} days. Each day’s units will stack here, autopilot and planner, once lots are committed.
          </Empty>
        )}
      </section>

      <section className="panel">
        <div className="viz-head">
          <h2>Lowest days of cover</h2>
          <span className="viz-note" title={new Date(m.cover.generatedAt).toISOString()}>
            Snapshot {relativeTime(m.cover.generatedAt, now)} · refreshed nightly
          </span>
        </div>
        {lowest.length ? (
          <CoverRankChart rows={lowest} />
        ) : (
          <Empty>No stock levels yet. The ten site and drug pairs closest to running out will rank here, against the 5-day floor.</Empty>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, flag, children }: { label: string; value: string; flag?: ReactNode; children: ReactNode }) {
  return (
    <div className="kpi">
      <h2 className="kpi-label">{label}</h2>
      <p className="kpi-value">
        {value}
        {flag}
      </p>
      <p className="kpi-detail">{children}</p>
    </div>
  );
}

function Empty({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="viz-empty">
      {title && <h2>{title}</h2>}
      <p>{children}</p>
    </div>
  );
}
