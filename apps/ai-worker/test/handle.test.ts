import { describe, expect, it } from "vitest";
import { handle, type AiEnv } from "../src/index";

const SECRET = "test-secret-123";

type Match = { id: string; score: number; metadata?: Record<string, unknown> };

function fakeEnv(opts: { matches?: Match[]; answer?: string } = {}) {
  const calls: string[] = [];
  const env: AiEnv = {
    AI_SHARED_SECRET: SECRET,
    AI: {
      run: async (model) => {
        calls.push(model);
        return model.includes("bge") ? { data: [[0.1, 0.2, 0.3]] } : { response: opts.answer ?? "NONE" };
      },
    },
    VEC: { query: (async () => ({ matches: opts.matches ?? [], count: opts.matches?.length ?? 0 })) as unknown as AiEnv["VEC"]["query"] },
  };
  return { env, calls };
}

const req = (body: unknown, secret: string | null = SECRET, path = "/precedent") =>
  new Request(`https://ai${path}`, {
    method: "POST",
    headers: secret === null ? {} : { "x-shortstop-secret": secret },
    body: JSON.stringify(body),
  });

const body = { lotId: "n_new-1", noticeId: "n_new", text: "Cisplatin: 150 vials allocated by Northstar." };
const pastCisplatin: Match = { id: "n_old-1", score: 0.91, metadata: { noticeId: "n_old", summary: "Cisplatin: 120 vials allocated by Northstar." } };

describe("shortstop-ai /precedent", () => {
  it("accepts either secret during a rotation window, and the old one stops working once retired", async () => {
    const { env } = fakeEnv();
    const rotating: AiEnv = { ...env, AI_SHARED_SECRET_NEXT: "next-secret-456" };
    expect((await handle(req(body, SECRET), rotating)).status).toBe(200);
    expect((await handle(req(body, "next-secret-456"), rotating)).status).toBe(200);
    // Retire the old key: next becomes current.
    const retired: AiEnv = { ...env, AI_SHARED_SECRET: "next-secret-456" };
    expect((await handle(req(body, SECRET), retired)).status).toBe(403);
    expect((await handle(req(body, "next-secret-456"), retired)).status).toBe(200);
  });

  it("rejects calls without the shared secret, or with the wrong one", async () => {
    const { env } = fakeEnv();
    expect((await handle(req(body, null), env)).status).toBe(403);
    expect((await handle(req(body, "wrong"), env)).status).toBe(403);
    const { AI_SHARED_SECRET: _, ...noSecret } = env;
    expect((await handle(req(body, SECRET), noSecret)).status).toBe(403);
  });

  it("404s anything but POST /precedent and 400s a bad body", async () => {
    const { env } = fakeEnv();
    expect((await handle(req(body, SECRET, "/other"), env)).status).toBe(404);
    expect((await handle(req({ nope: 1 }), env)).status).toBe(400);
  });

  it("returns a note grounded in retrieved records, with their ids as sources", async () => {
    const { env, calls } = fakeEnv({ matches: [pastCisplatin], answer: "Northstar sent 120 vials last cycle [1]." });
    const r = await (await handle(req(body), env)).json();
    expect(r).toEqual({ note: "Northstar sent 120 vials last cycle [1].", sources: ["n_old-1"] });
    expect(calls).toEqual(["@cf/baai/bge-base-en-v1.5", "@cf/meta/llama-3.1-8b-instruct-fast"]);
  });

  it("never calls the LLM without relevant precedents (low score, or the same notice)", async () => {
    const weak = { ...pastCisplatin, score: 0.3 };
    const self = { ...pastCisplatin, metadata: { ...pastCisplatin.metadata, noticeId: "n_new" } };
    const { env, calls } = fakeEnv({ matches: [weak, self], answer: "should not be used [1]" });
    expect(await (await handle(req(body), env)).json()).toEqual({ note: null, sources: [] });
    expect(calls).toEqual(["@cf/baai/bge-base-en-v1.5"]);
  });

  it("treats a malformed model response as no note instead of crashing", async () => {
    const { env } = fakeEnv({ matches: [pastCisplatin] });
    env.AI.run = async (model) => (model.includes("bge") ? { data: [[0.1, 0.2]] } : { response: { unexpected: true } });
    const res = await handle(req(body), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ note: null, sources: [] });
    env.AI.run = async () => ({ nothing: true });
    expect(await (await handle(req(body), env)).json()).toEqual({ note: null, sources: [] });
  });

  it("discards an answer that cites nothing or invents a record", async () => {
    for (const answer of ["Supply is tight.", "See [7].", "NONE"]) {
      const { env } = fakeEnv({ matches: [pastCisplatin], answer });
      expect(await (await handle(req(body), env)).json()).toEqual({ note: null, sources: [] });
    }
  });
});
