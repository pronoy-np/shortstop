/** ShortStop mark: a vial whose level stops short of the line, the moment the desk exists for. */
export function Logo({ title }: { title?: string }) {
  return (
    <svg viewBox="0 0 26 26" fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="7.5" y="2.75" width="11" height="20.5" rx="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 7h11" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.3 15.4h9.4v4.6a2.45 2.45 0 0 1-2.45 2.45h-4.5A2.45 2.45 0 0 1 8.3 20z" fill="var(--accent)" />
      <path d="M4.5 12.2h17" stroke="var(--accent)" strokeWidth="1.6" strokeDasharray="2 2" strokeLinecap="round" />
    </svg>
  );
}
