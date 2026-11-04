# Cluster C drill: a throwaway hello-world Worker

Run on 2026-11-04 against the same Cloudflare account as ShortStop. The Worker was named `shortstop-hello` and was deleted at the end. Its source is below; it was not kept in the repo, because the brief asks for the Worker to be torn down.

## What it exercised
- **`wrangler.jsonc` with a `vars` entry.** Vars are plain config that anyone with dashboard access can see, so they belong in the repo.
- **A secret, `DRILL_SECRET`, set with `wrangler secret put`.** The value was piped in and never printed or committed.
- **`curl`** against every route.
- **`wrangler tail`** showing live request logs.
- **An `ai` binding** answering through Workers AI, with no API key and no SDK.
- **`ctx.waitUntil`**, used to emit the log line after the response has been sent.
- **Teardown with `wrangler delete`.** The URL then returned 404.

## Source

```ts
export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    // ctx.waitUntil keeps work alive after the response is sent (here: a log line).
    ctx.waitUntil(Promise.resolve(console.log(`[hello] ${req.method} ${url.pathname}`)));
    if (url.pathname === "/secret") return Response.json({ secretIsSet: typeof env.DRILL_SECRET === "string" && env.DRILL_SECRET.length > 0 });
    if (url.pathname === "/ask") {
      const q = url.searchParams.get("q") ?? "In one sentence, what is a Cloudflare Worker?";
      const out = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages: [{ role: "user", content: q }], max_tokens: 80 })) as { response?: string };
      return Response.json({ q, answer: out.response });
    }
    return new Response(env.GREETING);
  },
} satisfies ExportedHandler<{ AI: Ai; GREETING: string; DRILL_SECRET?: string }>;
```

`wrangler.jsonc`: `name: "shortstop-hello"`, `ai: { binding: "AI" }`, `vars: { GREETING: "hello from the edge" }`.

## Log

```
$ wrangler deploy
env.AI                                    AI
env.GREETING ("hello from the edge")      Environment Variable
Uploaded shortstop-hello (4.07 sec)
  https://shortstop-hello.shortstop-worker.workers.dev

$ wrangler secret put DRILL_SECRET   (value piped in, not shown)
✨ Success! Uploaded secret DRILL_SECRET

$ curl /
hello from the edge
$ curl /secret
{"secretIsSet":true}
$ curl "/ask?q=..."
error code: 1101

$ wrangler tail shortstop-hello   (excerpt)
GET https://shortstop-hello.shortstop-worker.workers.dev/ - Ok
  (log) [hello] GET /
GET https://shortstop-hello.shortstop-worker.workers.dev/secret - Ok
  (log) [hello] GET /secret
GET .../ask?q=... - Exception Thrown
  ✘ AiError: 5028: @cf/meta/infire-llama-3.1-8b-instruct was deprecated on 2026-05-30.

# switched the model to @cf/meta/llama-3.1-8b-instruct-fast, redeployed
$ curl "/ask?q=In one sentence, why do Workers start faster than containers?"
{"answer":"Workers in a Kubernetes cluster start faster than containers because they are launched as separate processes, ..."}

$ wrangler delete shortstop-hello
Successfully deleted shortstop-hello
after teardown: 404
```

## What I took from it
- **The model the brief names is gone.** `@cf/meta/llama-3.1-8b-instruct` now returns `AiError 5028` (deprecated 2026-05-30). `wrangler tail` surfaced it straight away, where `curl` only showed `error code: 1101`. That's the case for tailing production rather than guessing. ShortStop already used the `-fast` variant, and pins model IDs in one constant (`packages/shared`) so a deprecation is a one-line change.
- **The 8B model's answer was confidently wrong.** It described Kubernetes when asked about Workers, which use V8 isolates. That's why ShortStop never lets the model decide quantities, validates every extraction with Zod, and discards any precedent note that doesn't cite the retrieved records.
