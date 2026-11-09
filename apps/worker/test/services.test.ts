import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { User } from "../src/lib/auth";
import { loadAudit } from "../src/services/audit";
import { loadBoard } from "../src/services/board";
import { countNeedsMe } from "../src/services/users";
import { cancelReservation, commitLot, listConfirmations, loadProposal, reviewSubstitute } from "../src/services/lots";
import { submitNotice } from "../src/services/notices";
import { updatePolicy } from "../src/services/policy";
import { OPS_LEAD, PHARMACIST, PLANNER, PLANNER_2, makeLot } from "./helpers";

const user = (email: string, role: User["role"]): User => ({ email, name: email, role });
const planner = user(PLANNER, "planner");
const planner2 = user(PLANNER_2, "planner");
const pharmacist = user(PHARMACIST, "pharmacist");
const opsLead = user(OPS_LEAD, "ops_lead");

describe("services return a discriminated result for every outcome", () => {
  it("invalid carries field errors from z.flattenError", async () => {
    const { lotId } = await makeLot();
    const r = await commitLot(env, planner, { lotId, commitKey: "svc-invalid-1", allocations: [{ siteId: "rci", quantity: -5 }] });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    if (r.ok) throw new Error("unreachable");
    expect(r.fieldErrors?.allocations?.length).toBeGreaterThan(0);

    expect(await commitLot(env, planner, { lotId, commitKey: "auto:mine", allocations: [{ siteId: "rci", quantity: 1 }] })).toMatchObject({
      code: "invalid",
      fieldErrors: { commitKey: ["commit keys may not start with auto:"] },
    });
    expect(await commitLot(env, planner, { lotId, commitKey: "svc-unknown", allocations: [{ siteId: "nowhere", quantity: 1 }] })).toMatchObject({
      code: "invalid",
      message: "unknown site",
    });
    expect(await reviewSubstitute(env, pharmacist, { lotId, decision: "maybe" })).toMatchObject({ code: "invalid", fieldErrors: { decision: expect.any(Array) } });
    expect(await updatePolicy(env, opsLead, { rules: [{ id: "BAD ID", when: {}, then: "x" }] })).toMatchObject({ code: "invalid" });
    expect(await loadAudit(env, { limit: "9999" })).toMatchObject({ code: "invalid", message: "limit must be 1-500" });
    expect(await submitNotice(env, planner, {})).toMatchObject({ code: "invalid", message: "attach a file or paste the notice text" });
  });

  it("not_found for malformed and unknown lot ids", async () => {
    expect(await commitLot(env, planner, { lotId: "../evil", commitKey: "svc-404-a", allocations: [{ siteId: "rci", quantity: 1 }] })).toMatchObject({ code: "not_found" });
    expect(await commitLot(env, planner, { lotId: "n_missing-1", commitKey: "svc-404-b", allocations: [{ siteId: "rci", quantity: 1 }] })).toMatchObject({ code: "not_found" });
    expect(await loadProposal(env, "n_missing-1")).toMatchObject({ ok: false, code: "not_found" });
    expect(await listConfirmations(env, "nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelReservation(env, planner, { lotId: 42, mode: "cancel" })).toMatchObject({ code: "not_found" });
  });

  it("conflict: lost race returns the rebased proposal; pending substitute is a hard floor", async () => {
    const { lotId } = await makeLot({ drugId: "cisplatin", quantity: 500 });
    expect(await commitLot(env, planner, { lotId, commitKey: "svc-first", allocations: [{ siteId: "rci", quantity: 400 }] })).toEqual({
      ok: true,
      available: 100,
      replay: false,
    });
    const lost = await commitLot(env, planner2, { lotId, commitKey: "svc-second", allocations: [{ siteId: "rumc", quantity: 200 }] });
    expect(lost).toMatchObject({ ok: false, code: "conflict", message: "insufficient", available: 100 });
    if (lost.ok) throw new Error("unreachable");
    expect(lost.proposal?.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(100);

    const sub = await makeLot({ substitutePending: true });
    expect(await commitLot(env, planner, { lotId: sub.lotId, commitKey: "svc-sub-pending", allocations: [{ siteId: "rci", quantity: 1 }] })).toMatchObject({
      code: "conflict",
      message: "pharmacist review of the substitute is required first",
    });
    expect(await cancelReservation(env, planner, { lotId, mode: "cancel" })).toMatchObject({ code: "conflict" });
  });

  it("key_conflict when a commit key is reused for a different commit; a same-key replay is ok", async () => {
    const { lotId } = await makeLot({ quantity: 100 });
    const input = { lotId, commitKey: "svc-key-1", allocations: [{ siteId: "rci", quantity: 10 }] };
    expect(await commitLot(env, planner, input)).toMatchObject({ ok: true, replay: false });
    expect(await commitLot(env, planner, input)).toMatchObject({ ok: true, replay: true });
    // The header-derived key wins over the body key.
    expect(await commitLot(env, planner, { ...input, idempotencyKey: "svc-key-1", commitKey: "ignored-key", allocations: [{ siteId: "rci", quantity: 20 }] })).toMatchObject({
      ok: false,
      code: "key_conflict",
      available: 90,
    });
  });

  it("two lots may share a client commit key: both keep their allocation rows", async () => {
    const a = await makeLot({ quantity: 100 });
    const b = await makeLot({ quantity: 100 });
    const key = "shared-batch-key";
    for (const { lotId } of [a, b])
      expect(await commitLot(env, planner, { lotId, commitKey: key, allocations: [{ siteId: "rci", quantity: 40 }] })).toMatchObject({ ok: true, replay: false });
    for (const { lotId } of [a, b]) {
      const rows = await env.DB.prepare(`SELECT quantity FROM allocations WHERE lot_id = ?`).bind(lotId).all<{ quantity: number }>();
      expect(rows.results).toEqual([{ quantity: 40 }]);
    }
  });

  it("forbidden: role floors live in the services, not only in the transport", async () => {
    const { lotId } = await makeLot({ substitutePending: true });
    expect(await commitLot(env, pharmacist, { lotId, commitKey: "svc-pharm", allocations: [{ siteId: "rci", quantity: 1 }] })).toMatchObject({ code: "forbidden" });
    expect(await reviewSubstitute(env, planner, { lotId, decision: "approved" })).toMatchObject({ code: "forbidden" });
    expect(await updatePolicy(env, planner, { rules: [] })).toMatchObject({ code: "forbidden", message: "requires role: ops_lead" });
    expect(await submitNotice(env, pharmacist, { text: "ondansetron 200 vials" })).toMatchObject({ code: "forbidden" });
    expect(await reviewSubstitute(env, pharmacist, { lotId, decision: "approved" })).toEqual({ ok: true });
  });

  it("an older notice with open work stays on the board after 25 newer notices; finished ones drop off", async () => {
    const old = await makeLot({ quantity: 50 });
    const done = await makeLot({ quantity: 10 });
    expect(await commitLot(env, planner, { lotId: done.lotId, commitKey: "svc-keep-done", allocations: [{ siteId: "rci", quantity: 10 }] })).toMatchObject({ ok: true });
    // 26 newer notices push both out of the newest 25.
    const base = Date.now() + 10_000;
    await env.DB.batch(
      Array.from({ length: 26 }, (_, i) =>
        env.DB.prepare(`INSERT INTO notices (id, r2_key, filename, content_type, status, created_by, created_at) VALUES (?, 'k', 'f.txt', 'text/plain', 'ready', ?, ?)`).bind(
          `n_keep${Date.now().toString(36)}${i}`,
          PLANNER,
          base + i,
        ),
      ),
    );
    const ids = (await loadBoard(env)).notices.map((n) => n.id);
    expect(ids).toContain(old.noticeId);
    expect(ids).not.toContain(done.noticeId);
    expect(ids.length).toBeLessThanOrEqual(100);
    expect(await countNeedsMe(env, "planner")).toBeGreaterThanOrEqual(1);
  });

  it("loadBoard adds a fresh split only for partly committed lots, and only when asked", async () => {
    const { lotId } = await makeLot({ drugId: "cisplatin", quantity: 300 });
    const untouched = await makeLot({ drugId: "cisplatin", quantity: 300 });
    expect(await commitLot(env, planner, { lotId, commitKey: "svc-board-1", allocations: [{ siteId: "rci", quantity: 100 }] })).toMatchObject({ ok: true });
    const lots = (b: Awaited<ReturnType<typeof loadBoard>>) => b.notices.flatMap((n) => n.lots);

    const plain = lots(await loadBoard(env));
    expect(plain.find((l) => l.id === lotId)).not.toHaveProperty("freshProposal");

    const fresh = lots(await loadBoard(env, { freshSplits: true }));
    const partly = fresh.find((l) => l.id === lotId)!;
    expect(partly.remaining).toBe(200);
    expect(partly.freshProposal!.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(200);
    expect(fresh.find((l) => l.id === untouched.lotId)).not.toHaveProperty("freshProposal");
  });
});
