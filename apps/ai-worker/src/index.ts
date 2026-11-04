import {
  EMBEDDING_MODEL,
  EmbeddingOutput,
  TextOutput,
  MIN_PRECEDENT_SCORE,
  PRECEDENT_MODEL,
  PrecedentRequest,
  buildPrecedentMessages,
  firstSentences,
  groundedSources,
  type PastRecord,
  type PrecedentResponse,
} from "@shortstop/shared";

/** The slice of the bindings this Worker needs; tests pass fakes with the same shape. */
export type AiEnv = {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  VEC: Pick<VectorizeIndex, "query">;
  AI_SHARED_SECRET?: string;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Constant-time string compare, so the shared secret can't be guessed byte by byte from timing. */
function sameSecret(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/**
 * RAG precedent: embed the new lot, retrieve similar past lots from Vectorize, and ask Llama for a
 * short note grounded only in those records. Answers with { note: null } rather than an ungrounded note.
 */
export async function handle(req: Request, env: AiEnv): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/precedent") return json({ error: "not found" }, 404);
  if (!env.AI_SHARED_SECRET || !sameSecret(req.headers.get("x-shortstop-secret") ?? "", env.AI_SHARED_SECRET))
    return json({ error: "forbidden" }, 403);

  const parsed = PrecedentRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid body" }, 400);
  const { noticeId, text } = parsed.data;

  const embedded = EmbeddingOutput.safeParse(await env.AI.run(EMBEDDING_MODEL, { text: [text] }));
  const vector = embedded.success ? embedded.data.data[0] : undefined;
  if (!vector) return json({ note: null, sources: [] } satisfies PrecedentResponse);

  const found = await env.VEC.query(vector, { topK: 6, returnMetadata: "all" });
  const past: PastRecord[] = found.matches
    .filter((m) => m.score >= MIN_PRECEDENT_SCORE && m.metadata?.noticeId !== noticeId && typeof m.metadata?.summary === "string")
    .slice(0, 4)
    .map((m) => ({ lotId: m.id, summary: String(m.metadata!.summary) }));
  if (past.length === 0) {
    console.log(JSON.stringify({ precedent: "no_matches", noticeId, scores: found.matches.map((m) => m.score) }));
    return json({ note: null, sources: [] } satisfies PrecedentResponse);
  }

  const out = TextOutput.safeParse(
    await env.AI.run(PRECEDENT_MODEL, {
      messages: buildPrecedentMessages(text, past),
      temperature: 0,
      max_tokens: 160,
    }),
  );
  if (!out.success) {
    console.log(JSON.stringify({ precedent: "discarded_bad_output", noticeId }));
    return json({ note: null, sources: [] } satisfies PrecedentResponse);
  }
  const note = firstSentences(out.data.response);
  const sources = groundedSources(note, past);
  console.log(JSON.stringify({ precedent: sources ? "grounded" : "discarded_ungrounded", noticeId, records: past.length, answer: note.slice(0, 300) }));
  return json((sources ? { note, sources } : { note: null, sources: [] }) satisfies PrecedentResponse);
}

export default {
  fetch: (req, env) => handle(req, env as unknown as AiEnv),
} satisfies ExportedHandler<Env>;
