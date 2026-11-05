import type { Allocation, SplitResult } from "@shortstop/shared";
import type { AuthFailCode } from "../lib/auth";
import type { FailCode, FieldErrors } from "../services/result";

// Client-safe (types and one constant): form islands import this, never forms.ts, which pulls in the services.

/** What a form shows after a submit (`useActionState`). `code` lets the form react to a specific outcome. */
export type FormState = {
  ok: boolean | null;
  code?: FailCode | AuthFailCode;
  message?: string;
  fieldErrors?: FieldErrors;
  /** Commit lost the race, or a take-over: what is left, and a fresh split of it. */
  available?: number;
  proposal?: SplitResult;
  /** Take-over: the reserved autopilot split, to start the editor from. */
  allocations?: Allocation[];
  /** Successful commit: the key it landed under (for the confirmation links). */
  commitKey?: string;
  noticeId?: string;
};

export const idleState: FormState = { ok: null };
