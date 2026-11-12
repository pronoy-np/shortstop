"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { idleState } from "../../../../src/actions/state";
import { resetScarcityAction } from "../../../_lib/actions";

/** Ops lead only: counts everything allocated so far as delivered and used, so sites are short again. */
export function ResetScarcity() {
  const router = useRouter();
  const [state, action, pending] = useActionState(resetScarcityAction, idleState);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);
  return (
    <form
      action={action}
      className="row gap"
      onSubmit={(e) => {
        if (!confirm("Count every allocation so far as delivered and used? Sites go back to their baseline stock, and open lots get a fresh split.")) e.preventDefault();
      }}
    >
      {state.message && (
        <span className="small" role={state.ok ? "status" : "alert"}>
          {state.message}
        </span>
      )}
      <button className="button secondary" type="submit" disabled={pending}>
        <RotateCcw className="icon" aria-hidden /> {pending ? "Resetting…" : "Reset scarcity"}
      </button>
    </form>
  );
}
