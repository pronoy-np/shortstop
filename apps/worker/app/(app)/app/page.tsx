import { loadBoard } from "../../../src/services/board";
import { searchBoard } from "../../../src/services/search";
import { viewer, workerEnv } from "../../_lib/server";
import { BoardClient, type BoardSearch } from "./board-client";

/** The board, rendered on the server: lots with fresh splits for partly committed ones, and `?q=` search results. */
export default async function BoardPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const me = await viewer();
  const env = await workerEnv();
  const q = (await searchParams).q;
  const query = typeof q === "string" ? q.trim() : "";
  const [board, found] = await Promise.all([loadBoard(env, { freshSplits: true }), query ? searchBoard(env, { q: query }) : null]);
  const search: BoardSearch | null = found ? { q: query, hits: found.ok ? found.hits : null, error: found.ok ? null : found.message } : null;
  return <BoardClient me={me} board={board} search={search} />;
}
