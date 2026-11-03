import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [health, setHealth] = useState<string>("…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<{ ok: boolean }>)
      .then((j) => setHealth(j.ok ? "ok" : "down"))
      .catch(() => setHealth("down"));
  }, []);

  return (
    <main>
      <h1>ShortStop</h1>
      <p>API: {health}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
