import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PLANNER, PLANNER_2, lotRow, makeLot } from "./helpers";

const all = (qty: number) => [
  { siteId: "rci", quantity: Math.floor(qty / 2) },
  { siteId: "rumc", quantity: qty - Math.floor(qty / 2) },
];

const allocationRows = async (lotId: string) =>
  (await env.DB.prepare(`SELECT * FROM allocations WHERE lot_id = ?`).bind(lotId).all()).results;

describe("LotDO", () => {
  it("two planners racing for the whole lot: exactly one wins, ledger never goes negative", async () => {
    const { lotId, stub } = await makeLot({ quantity: 500 });
    const [a, b] = await Promise.all([stub.commit("k-a", all(500), PLANNER), stub.commit("k-b", all(500), PLANNER_2)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, reason: "insufficient", available: 0 });
    expect((await stub.state()).available).toBe(0);
    expect(await allocationRows(lotId)).toHaveLength(2);
    expect(await lotRow(lotId)).toMatchObject({ status: "committed", remaining: 0 });
  });

  it("many concurrent commits never over-allocate", async () => {
    const { stub } = await makeLot({ quantity: 100 });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => stub.commit(`k-${i}`, [{ siteId: "rci", quantity: 30 }], PLANNER)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const s = await stub.state();
    expect(s.committed).toBe(90);
    expect(s.available).toBe(10);
  });

  it("partial commit leaves the rest for the next planner, who learns exactly what is left", async () => {
    const { lotId, stub } = await makeLot({ quantity: 500 });
    expect(await stub.commit("k-1", [{ siteId: "rci", quantity: 360 }], PLANNER)).toMatchObject({ ok: true, available: 140 });
    expect(await stub.commit("k-2", all(500), PLANNER_2)).toMatchObject({ ok: false, available: 140 });
    expect(await lotRow(lotId)).toMatchObject({ status: "open", remaining: 140 });
  });

  it("replaying a commit key is idempotent", async () => {
    const { lotId, stub } = await makeLot({ quantity: 500 });
    await stub.commit("same-key", all(200), PLANNER);
    const again = await stub.commit("same-key", all(200), PLANNER);
    expect(again).toMatchObject({ ok: true, replay: true, available: 300 });
    expect(await allocationRows(lotId)).toHaveLength(2);
    const audits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'lot.committed'`)
      .bind(lotId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("autopilot reservation holds stock, then finalises as an auto commit with a confirmation", async () => {
    const { lotId, stub } = await makeLot({ drugId: "ondansetron", quantity: 500 });
    const r = await stub.reserveAuto({ commitKey: `auto:${lotId}`, allocations: all(200), ruleId: "small-auto", policyVersion: 3, windowMs: 15 * 60_000 });
    expect(r).toMatchObject({ ok: true, available: 300 });
    expect(await lotRow(lotId)).toMatchObject({ status: "reserved", remaining: 300 });

    // Reserved stock is not available to humans.
    expect(await stub.commit("k-h", all(400), PLANNER)).toMatchObject({ ok: false, available: 300 });
    // Not due yet: nothing happens.
    expect(await stub.finalizeIfDue(Date.now())).toBe(false);

    expect(await stub.finalizeIfDue(Date.now() + 16 * 60_000)).toBe(true);
    const s = await stub.state();
    expect(s).toMatchObject({ committed: 200, reserved: 0, available: 300, reservation: null });
    const rows = await allocationRows(lotId);
    expect(rows.every((a) => a.kind === "auto" && a.actor === "autopilot:small-auto@v3")).toBe(true);
    expect(await lotRow(lotId)).toMatchObject({ status: "open", remaining: 300 });
    const confirmations = await env.FILES.list({ prefix: `confirmations/${lotId}/` });
    expect(confirmations.objects).toHaveLength(1);
    expect(await (await env.FILES.get(confirmations.objects[0]!.key))!.text()).toContain("autopilot:small-auto@v3");
  });

  it("cancel and take-over release the reservation", async () => {
    const { lotId, stub } = await makeLot({ drugId: "ondansetron", quantity: 300 });
    await stub.reserveAuto({ commitKey: `auto:${lotId}`, allocations: all(300), ruleId: null, policyVersion: 1, windowMs: 60_000 });
    expect(await stub.reserveAuto({ commitKey: "other", allocations: all(10), ruleId: null, policyVersion: 1, windowMs: 1 })).toMatchObject({
      ok: false,
      reason: "reserved",
    });
    expect(await stub.cancelReservation(PLANNER, "takeover")).toMatchObject({ ok: true, available: 300 });
    expect(await lotRow(lotId)).toMatchObject({ status: "open", remaining: 300, finalizes_at: null });
    expect(await stub.finalizeIfDue(Date.now() + 120_000)).toBe(false);
    expect(await stub.cancelReservation(PLANNER, "cancel")).toMatchObject({ ok: false });
    const actions = (await env.DB.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).bind(lotId).all<{ action: string }>()).results.map(
      (r) => r.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["lot.reserved", "lot.taken_over"]));
  });

  it("refuses commits on an uninitialised lot", async () => {
    const stub = env.LOT_DO.get(env.LOT_DO.idFromName("never-initialised"));
    expect(await stub.commit("k", all(2), PLANNER)).toMatchObject({ ok: false, reason: "not_initialised" });
  });
});
