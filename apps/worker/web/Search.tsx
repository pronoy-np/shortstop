import { useState, type FormEvent } from "react";
import { api } from "./api";

type Hit = {
  lotId: string;
  score: number;
  summary: string;
  lot: { noticeId: string; status: string; quantity: number; remaining: number; drugName: string };
};

/** Search past and current lots by meaning (Workers AI embeddings + Vectorize). */
export function SearchBox() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setHits((await api<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}`)).hits);
    } catch (err) {
      setError((err as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack">
      <form className="row gap wrap" onSubmit={run} role="search">
        <input
          className="grow"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search lots by meaning, e.g. “platinum chemo short at the cancer institute”"
          aria-label="Search lots by meaning"
        />
        <button className="primary" disabled={busy || q.trim().length < 2}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
      {hits && hits.length === 0 && <p className="muted small">No similar lots yet. Lots are indexed as notices are ingested.</p>}
      {hits && hits.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Lot</th>
              <th>What</th>
              <th className="num">Similarity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.lotId}>
                <td className="mono small">{h.lotId}</td>
                <td className="small">{h.summary}</td>
                <td className="num">{h.score.toFixed(2)}</td>
                <td className="small">{h.lot.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
