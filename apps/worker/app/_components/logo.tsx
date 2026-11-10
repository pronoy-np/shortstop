/**
 * ShortStop mark: a capped vial whose teal level sits below the floor line, the moment the desk exists for.
 * Drawn on a 24-unit grid with 2-unit strokes so it stays crisp at 16px and 28px.
 */
export function Logo({ title }: { title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="7" y="1.5" width="10" height="3" rx="1" fill="currentColor" />
      <rect x="8" y="6.5" width="8" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="10" y="14" width="4" height="6" rx="1" fill="var(--np-teal)" />
      <path d="M4 11.5h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
