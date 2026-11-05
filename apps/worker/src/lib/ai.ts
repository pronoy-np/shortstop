import type { AiRunner } from "@shortstop/shared";

export type MarkdownAi = { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data?: string; format?: string }[]> };

/**
 * The one place the Workers AI binding is narrowed to the two calls ShortStop makes: `run` (whose output is
 * Zod-validated by every caller) and `toMarkdown`. The binding's generated types are model-specific overloads,
 * so the narrowing happens here once instead of as casts at each call site.
 */
type GatewayRun = { run(model: string, input: Record<string, unknown>, opts?: { gateway: { id: string; skipCache: boolean } }): Promise<unknown> };

/**
 * With AI_GATEWAY_ID set, every model call goes through AI Gateway (logs, rate limits). The gateway cache stays off
 * here: extraction is already cached in KV by content hash, and embeddings are cheap.
 */
export const workersAi = (env: Env): AiRunner & MarkdownAi => {
  const ai = env.AI as unknown as GatewayRun & MarkdownAi;
  const id = env.AI_GATEWAY_ID;
  if (!id) return ai;
  return { run: (model, input) => ai.run(model, input, { gateway: { id, skipCache: true } }), toMarkdown: (files) => ai.toMarkdown(files) };
};
