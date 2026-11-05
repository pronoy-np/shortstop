"use client";

import { useEffect } from "react";

/** A render error in a desk page: a recoverable message instead of a blank page (the layout and tabs stay). */
export default function DeskError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error("UI error", error), [error]);
  return (
    <div className="callout error" role="alert">
      <span className="title">This screen hit an error and stopped.</span>
      <p className="small">{error.digest ? `Reference ${error.digest}` : error.message}</p>
      <div>
        <button className="primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
