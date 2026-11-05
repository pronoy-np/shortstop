import type { Role } from "@shortstop/shared";
import { z } from "zod";
import type { User } from "../lib/auth";

/**
 * The service seam's result shape. Services never throw for an expected outcome: they return one of these, and each
 * transport (the Hono API today, Server Actions next) maps `code` to its own form. The compiler makes every adapter
 * handle every code.
 */
export type FailCode = "invalid" | "not_found" | "conflict" | "key_conflict" | "forbidden";
export type FieldErrors = Record<string, string[] | undefined>;
export type Fail<Extra extends object = {}> = { ok: false; code: FailCode; message: string; fieldErrors?: FieldErrors } & Extra;
export type Result<T extends object, Extra extends object = {}> = ({ ok: true } & T) | Fail<Extra>;

export const fail = <E extends object = {}>(code: FailCode, message: string, extra?: E): Fail<E> =>
  ({ ok: false, code, message, ...extra }) as Fail<E>;

/** A zod failure as `code: "invalid"`, with field errors for forms. `message` defaults to the first issue. */
export function invalid(error: z.ZodError, message?: string): Fail {
  return { ok: false, code: "invalid", message: message ?? error.issues[0]?.message ?? "invalid input", fieldErrors: z.flattenError(error).fieldErrors };
}

/** An invalid result for one field, for checks that run after the schema (unknown site, key namespace). */
export const invalidField = (field: string, message: string): Fail => ({ ok: false, code: "invalid", message, fieldErrors: { [field]: [message] } });

/** The role floor, checked inside every write so no transport can skip it. */
export function forbidUnless(actor: User, roles: readonly Role[]): Fail | null {
  return roles.includes(actor.role) ? null : fail("forbidden", `requires role: ${roles.join(" or ")}`);
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
