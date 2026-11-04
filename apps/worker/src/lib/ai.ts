import type { AiRunner } from "@shortstop/shared";

export type MarkdownAi = { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data?: string; format?: string }[]> };

/**
 * The one place the Workers AI binding is narrowed to the two calls ShortStop makes: `run` (whose output is
 * Zod-validated by every caller) and `toMarkdown`. The binding's generated types are model-specific overloads,
 * so the narrowing happens here once instead of as casts at each call site.
 */
export const workersAi = (env: Env): AiRunner & MarkdownAi => env.AI as unknown as AiRunner & MarkdownAi;
