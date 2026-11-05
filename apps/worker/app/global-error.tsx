"use client";

import "./styles.css";

/** Last line of defence: an error in the root layout itself. Replaces the whole document, so it renders its own <html>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="content" style={{ paddingTop: 40 }}>
          <div className="callout error" role="alert">
            <span className="title">ShortStop hit an error and stopped.</span>
            <p className="small">{error.digest ? `Reference ${error.digest}` : error.message}</p>
            <div>
              <button className="primary" onClick={reset}>
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
