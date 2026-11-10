import { TriangleAlert } from "lucide-react";
import { COVER_FLOOR_DAYS } from "../../../_components/cover-bar";

export type CoverRow = { siteName: string; drugName: string; tier: number; cover: number };

const BAR = 12; // bar thickness in px

/**
 * The lowest days of cover, ranked, on one shared scale with the 5-day floor drawn through every row.
 * Bars are SVG; names and values are HTML text, so every number is readable without hovering.
 */
export function CoverRankChart({ rows }: { rows: CoverRow[] }) {
  const max = Math.max(10, Math.ceil(Math.max(...rows.map((r) => r.cover)) / 5) * 5);
  const pct = (d: number) => `${(Math.max(0, Math.min(d, max)) / max) * 100}%`;
  const ticks = Array.from({ length: max / 5 + 1 }, (_, i) => i * 5);
  const below = rows.filter((r) => r.cover < COVER_FLOOR_DAYS).length;

  return (
    <div className="rank" style={{ ["--floor-x" as string]: pct(COVER_FLOOR_DAYS) }}>
      <ol className="rank-rows" aria-label={`${rows.length} lowest site and drug pairs by days of cover; ${below} under the ${COVER_FLOOR_DAYS}-day floor`}>
        {rows.map((r, i) => {
          const low = r.cover < COVER_FLOOR_DAYS;
          return (
            <li key={i} className={`rank-row${low ? " is-low" : ""}`}>
              <span className="rank-name">
                <span className={`tier t${r.tier}`} title={`Tier ${r.tier}`}>
                  T{r.tier}
                </span>
                <span className="rank-text">
                  <b>{r.drugName}</b>
                  <span className="muted">{r.siteName}</span>
                </span>
              </span>
              <svg className="rank-bar" width="100%" height="30" aria-hidden focusable="false">
                {ticks.slice(1).map((t) =>
                  t === COVER_FLOOR_DAYS ? null : <line key={t} className="viz-grid" x1={pct(t)} x2={pct(t)} y1="0" y2="100%" />,
                )}
                <svg y="50%" overflow="visible">
                  <rect className="bar" x="0" y={-BAR / 2} width={pct(r.cover)} height={BAR} rx="4" />
                  {r.cover > 0.4 && <rect className="bar" x="0" y={-BAR / 2} width="4" height={BAR} />}
                </svg>
                <line className="viz-floor" x1={pct(COVER_FLOOR_DAYS)} x2={pct(COVER_FLOOR_DAYS)} y1="0" y2="100%" />
              </svg>
              <span className={`rank-val${low ? " error" : ""}`}>
                {low && <TriangleAlert className="icon" aria-hidden />}
                {r.cover}d<span className="sr-only">{low ? ", under the floor" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="rank-axis" aria-hidden>
        <span />
        <span className="rank-ticks">
          {ticks.map((t) => (
            <span key={t} className={t === COVER_FLOOR_DAYS ? "floor" : undefined} style={{ left: pct(t) }}>
              {t === COVER_FLOOR_DAYS ? `${t}d floor` : `${t}d`}
            </span>
          ))}
        </span>
        <span />
      </div>
    </div>
  );
}
