const COVER_FLOOR_DAYS = 5;
const COVER_SCALE_DAYS = 30;

/** Days of cover after a split, against the 5-day floor. `label` adds an accessible name (board rows). */
export function CoverBar({ days, label = false, warnValue = false }: { days: number; label?: boolean; warnValue?: boolean }) {
  const w = `${Math.min(100, (days / COVER_SCALE_DAYS) * 100)}%`;
  const floor = `${(COVER_FLOOR_DAYS / COVER_SCALE_DAYS) * 100}%`;
  const low = days < COVER_FLOOR_DAYS;
  return (
    <span
      className="cover"
      {...(label ? { role: "img", "aria-label": `${days} days of cover after the split, floor ${COVER_FLOOR_DAYS} days` } : {})}
    >
      <span className="cover-track" aria-hidden>
        <span className={`cover-fill ${low ? "low" : ""}`} style={{ ["--w" as string]: w }} />
        <span className="cover-floor" style={{ ["--floor" as string]: floor }} />
      </span>
      <span className={`cover-val ${warnValue && low ? "error" : ""}`} aria-hidden={label || undefined}>
        {days}d
      </span>
    </span>
  );
}
