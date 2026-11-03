import type { BoardEvent } from "@shortstop/shared";

export const DESK = "central-pharmacy";

export const boardStub = (env: Env) => env.BOARD_DO.get(env.BOARD_DO.idFromName(DESK));

/** Live-board fan-out is best effort: a failed broadcast must never fail the state change. */
export async function broadcast(env: Env, event: BoardEvent): Promise<void> {
  try {
    await boardStub(env).broadcast(event);
  } catch (err) {
    console.warn("broadcast failed", err);
  }
}
