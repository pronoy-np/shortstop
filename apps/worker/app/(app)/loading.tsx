export default function Loading() {
  return (
    <div className="stack" aria-busy="true">
      <p className="muted" role="status">
        Loading…
      </p>
      <div className="panel" style={{ minHeight: 160, opacity: 0.6 }} aria-hidden />
    </div>
  );
}
