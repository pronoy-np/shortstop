import { Info } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An ⓘ that opens a short note. A <details>, so it works without script, is reachable by keyboard (Enter or Space on
 * the summary) and tells screen readers whether it is open.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="tip">
      <summary aria-label={label} title={label}>
        <Info className="icon" aria-hidden />
      </summary>
      <div className="tip-body small">{children}</div>
    </details>
  );
}
