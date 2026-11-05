import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { cache } from "react";
import { resolveUser } from "../../src/lib/auth";

/**
 * The incoming request as a plain Request, for the transport-free guards (`resolveUser`, `withActor`): same cookies,
 * Access JWT and host. Reading `headers()` first also marks the route dynamic before `getCloudflareContext` runs
 * (OpenNext issue 652).
 */
export async function incomingRequest(path: string, method: "GET" | "POST" = "GET"): Promise<Request> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  return new Request(`${proto}://${h.get("host") ?? "localhost"}${path}`, { method, headers: new Headers(h) });
}

/** The Worker env: the same object `src/entry.ts` receives (OpenNext's `CloudflareEnv` type just doesn't know our bindings). */
export async function workerEnv(): Promise<Env> {
  return (await getCloudflareContext({ async: true })).env as unknown as Env;
}

/** Request and env for a Server Action, in that order (see `incomingRequest`). */
export async function actionContext(path = "/app"): Promise<{ req: Request; env: Env }> {
  const req = await incomingRequest(path, "POST");
  return { req, env: await workerEnv() };
}

/** Who is viewing, once per request however many server components ask. */
export const currentUser = cache(async () => {
  const req = await incomingRequest("/app");
  return resolveUser(await workerEnv(), req);
});

/** For pages under the (app) layout, which has already redirected or refused anyone else. */
export async function viewer() {
  const r = await currentUser();
  if (!r.ok) throw new Error(r.message);
  return r.user;
}
