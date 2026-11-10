export const COVER_FLOOR_DAYS = 5;
export const COVER_SCALE_DAYS = 30;
const TICKS = [10, 15, 20, 25];
const pct = (days: number) => `${(Math.max(0, Math.min(days, COVER_SCALE_DAYS)) / COVER_SCALE_DAYS) * 100}%`;

/**
 * Days of cover after a split, on a 0–30 day track with a graduation every 5 days and a marker at the 5-day floor.
 * `label` adds an accessible name (board rows); otherwise the value text is read out. Server- and client-safe: no hooks.
 */
export function CoverBar({ days, label = false, warnValue = false }: { days: number; label?: boolean; warnValue?: boolean }) {
  const low = days < COVER_FLOOR_DAYS;
  return (
    <span
      className={`cover${low ? " is-low" : ""}`}
      title={`Days of cover: about ${days} days of stock at this site's usual use after the split. Under ${COVER_FLOOR_DAYS} days is flagged.`}
      {...(label ? { role: "img", "aria-label": `${days} days of cover after the split, floor ${COVER_FLOOR_DAYS} days` } : {})}
    >
      <svg className="cover-svg" height="16" aria-hidden focusable="false">
        <rect className="cover-track" x="0" y="4" width="100%" height="8" rx="4" />
        {TICKS.map((d) => (
          <line key={d} className="cover-tick" x1={pct(d)} x2={pct(d)} y1="4" y2="12" />
        ))}
        {days > 0 && <rect className="cover-fill" x="0" y="4" width={pct(days)} height="8" rx="4" />}
        <line className="cover-floor" x1={pct(COVER_FLOOR_DAYS)} x2={pct(COVER_FLOOR_DAYS)} y1="1.5" y2="14.5" />
      </svg>
      <span className={`cover-val ${warnValue && low ? "error" : ""}`} aria-hidden={label || undefined}>
        {days}d
      </span>
    </span>
  );
}
