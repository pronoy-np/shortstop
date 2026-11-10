import { fmt } from "../../../_lib/format";

export type Day = { day: string; label: string; auto: number; manual: number };

const H = 168; // plot height in px; the x-axis band sits below it in HTML
const BAR = 16; // column width in px (capped well under 24 so the slot keeps its air)
const R = 4; // rounded data-end
const GAP = 2; // surface gap between stacked segments

/** A nice axis top and step for a maximum (1/2/5 × 10^k, three or four gridlines). */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}

/** A column segment with a rounded top (data end) and a square bottom (baseline side). x is centred on 0. */
function segment(y: number, h: number, roundTop: boolean): string {
  const x0 = -BAR / 2;
  const x1 = BAR / 2;
  const yb = y + h;
  const r = roundTop ? Math.min(R, h, BAR / 2) : 0;
  if (!r) return `M${x0} ${yb}V${y}H${x1}V${yb}Z`;
  return `M${x0} ${yb}V${y + r}Q${x0} ${y} ${x0 + r} ${y}H${x1 - r}Q${x1} ${y} ${x1} ${y + r}V${yb}Z`;
}

/**
 * Units committed per day, autopilot stacked under planner. Pure SVG from the server: no client JS.
 * Marks are SVG; axis text is HTML so it stays legible at any width. Every number is also in the table view.
 */
export function DailyUnitsChart({ days }: { days: Day[] }) {
  const totals = days.map((d) => d.auto + d.manual);
  const sumAuto = days.reduce((s, d) => s + d.auto, 0);
  const sumManual = days.reduce((s, d) => s + d.manual, 0);
  const { top, step } = niceScale(Math.max(...totals));
  const y = (v: number) => H - (v / top) * H;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const peak = totals.indexOf(Math.max(...totals));
  const n = days.length;
  const xLabels = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  const summary =
    `Units committed per day over the last ${n} days: ${fmt.format(sumAuto)} by autopilot and ${fmt.format(sumManual)} by planners. ` +
    `Busiest day ${days[peak]!.label} with ${fmt.format(totals[peak]!)} units.`;

  return (
    <figure className="viz" aria-labelledby="daily-title">
      <figcaption className="viz-head">
        <h2 id="daily-title">Units committed per day</h2>
        <ul className="viz-legend" aria-label="Legend">
          <li>
            <span className="key auto" aria-hidden />
            Autopilot <b>{fmt.format(sumAuto)}</b>
          </li>
          <li>
            <span className="key manual" aria-hidden />
            Planner <b>{fmt.format(sumManual)}</b>
          </li>
        </ul>
      </figcaption>

      <div className="cols" style={{ ["--ylab" as string]: `${String(top).length + 1}ch` }}>
        <div className="cols-y" aria-hidden style={{ height: H }}>
          {ticks.map((t) => (
            <span key={t} style={{ top: y(t) }}>
              {fmt.format(t)}
            </span>
          ))}
        </div>
        <svg className="cols-plot" width="100%" height={H} role="img" aria-label={summary}>
          {ticks.map((t) => (
            <line key={t} className={t === 0 ? "viz-base" : "viz-grid"} x1="0" x2="100%" y1={y(t) - 0.5} y2={y(t) - 0.5} />
          ))}
          {days.map((d, i) => {
            const total = d.auto + d.manual;
            const autoH = (d.auto / top) * H;
            const manualH = (d.manual / top) * H;
            return (
              <svg key={d.day} x={`${((i + 0.5) / n) * 100}%`} overflow="visible">
                <g className="col">
                <title>{`${d.label}: ${fmt.format(d.auto)} autopilot, ${fmt.format(d.manual)} planner`}</title>
                <rect className="col-hit" x={-BAR} y="0" width={BAR * 2} height={H} />
                {d.auto > 0 && <path className="seg auto" d={segment(H - autoH, autoH, d.manual === 0)} />}
                {d.manual > 0 && (
                  <path className="seg manual" d={segment(H - autoH - manualH + (d.auto > 0 ? GAP : 0), manualH - (d.auto > 0 ? GAP : 0), true)} />
                )}
                {i === peak && total > 0 && (
                  <text className="viz-label" x="0" y={y(total) - 6} textAnchor="middle">
                    {fmt.format(total)}
                  </text>
                )}
                </g>
              </svg>
            );
          })}
        </svg>
        <div className="cols-x" aria-hidden>
          {days.map((d, i) => (
            <span key={d.day} className={i === 0 ? "first" : i === n - 1 ? "last" : undefined}>
              {xLabels.has(i) ? (i === n - 1 ? "Today" : d.label) : ""}
            </span>
          ))}
        </div>
      </div>

      <details className="viz-table">
        <summary>Show as a table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="num">Autopilot</th>
                <th className="num">Planner</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{d.label}</td>
                  <td className="num">{fmt.format(d.auto)}</td>
                  <td className="num">{fmt.format(d.manual)}</td>
                  <td className="num">{fmt.format(d.auto + d.manual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
