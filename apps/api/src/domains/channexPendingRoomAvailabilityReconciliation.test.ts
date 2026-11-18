import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authority: vi.fn(),
  reconcile: vi.fn(),
  supersede: vi.fn(),
  closed: vi.fn(),
}));
vi.mock("./channexPricingPropertyAuthority.js", () => ({
  lockChannexPricingPropertyAuthority: dependencies.authority,
}));
vi.mock("./channexRoomAvailabilityEvidence.js", () => ({
  reconcileCurrentChannexRoomAvailability: dependencies.reconcile,
}));
vi.mock("./channexRoomAvailabilitySupersede.js", () => ({
  supersedeChannexRoomAvailabilityAttempt: dependencies.supersede,
}));
vi.mock("./channexRoomAvailabilityCoordinator.js", () => ({
  channexCutOffClosesNight: dependencies.closed,
}));
import { reconcilePendingChannexRoomAvailability } from "./channexPendingRoomAvailabilityReconciliation.js";

function pendingPool(candidates: unknown[]) {
  const query = vi.fn(async (sql: string) =>
    sql.includes("FROM pms.channex_room_availability_attempts")
      ? { rows: candidates }
      : { rows: [] },
  );
  return { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
}

const lease = { jobId: "job", attemptNumber: 2, workerId: "worker" };

describe("pending Channex room availability reconciliation", () => {
  it("supersedes a send it can't reconcile and goes on; keeps the failure otherwise", async () => {
    dependencies.authority.mockResolvedValue({
      kind: "authorized",
      lease: { operationType: "sync_ari", propertyId: "property" },
    });
    const send = { attemptId: "send", roomTypeId: "room", date: "2026-09-01", admissible: true };
    const changed = { kind: "unavailable", reason: "consumer_authority_unavailable" };
    dependencies.reconcile.mockReset().mockResolvedValue(changed);
    dependencies.supersede
      .mockReset()
      .mockResolvedValueOnce({ kind: "availability_superseded" })
      .mockResolvedValueOnce({ kind: "availability_attempt_resolved" })
      .mockResolvedValueOnce({ kind: "unavailable", reason: "availability_supersede_unavailable" });
    const get = vi.fn();
    const run = () =>
      reconcilePendingChannexRoomAvailability(pendingPool([send]), {} as never, lease, get);
    await expect(run()).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    await expect(run()).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    await expect(run()).resolves.toEqual(changed);
    expect(dependencies.supersede).toHaveBeenCalledTimes(3);
  });

  it("waits out an ambiguous send's settle window before superseding it", async () => {
    dependencies.authority.mockResolvedValue({
      kind: "authorized",
      lease: { operationType: "sync_ari", propertyId: "property" },
    });
    const lost = { attemptId: "lost", roomTypeId: "room", date: "2026-09-01", admissible: false };
    dependencies.reconcile.mockReset();
    dependencies.supersede
      .mockReset()
      .mockResolvedValueOnce({ kind: "availability_send_settling" })
      .mockResolvedValueOnce({ kind: "availability_superseded" })
      .mockResolvedValueOnce({ kind: "unavailable", reason: "availability_supersede_unavailable" });
    const get = vi.fn();
    const run = () =>
      reconcilePendingChannexRoomAvailability(pendingPool([lost]), {} as never, lease, get);
    await expect(run()).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_send_settling",
    });
    await expect(run()).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    await expect(run()).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_receipt_history_unavailable",
    });
    expect(dependencies.reconcile).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("processes ten oldest retained candidates and returns a bounded continuation", async () => {
    const candidates = Array.from({ length: 11 }, (_, index) => ({
      attemptId: `attempt-${index}`,
      roomTypeId: `room-${index}`,
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      admissible: true,
    }));
    dependencies.authority.mockResolvedValue({
      kind: "authorized",
      lease: { operationType: "sync_ari", propertyId: "property" },
    });
    dependencies.reconcile.mockResolvedValue({ kind: "availability_reconciled" });
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM pms.channex_room_availability_attempts")) {
        expect(values).toEqual(["property"]);
        expect(sql).toContain("ORDER BY attempt.created_at,attempt.id LIMIT 11");
        return { rows: candidates };
      }
      return { rows: [] };
    });
    const pool = {
      connect: async () => ({ query, release: vi.fn() }),
    } as unknown as Pool;
    await expect(
      reconcilePendingChannexRoomAvailability(
        pool,
        {} as never,
        { jobId: "job", attemptNumber: 2, workerId: "worker" },
        vi.fn(),
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_reconciliation_batch_pending",
    });
    expect(dependencies.reconcile).toHaveBeenCalledTimes(10);
    expect(dependencies.reconcile.mock.calls.map((call) => call[3])).toEqual(
      candidates.slice(0, 10).map(({ roomTypeId, date }) => ({ roomTypeId, date })),
    );
  });

  // VAY-2108: after the property's Channex cut-off, tonight reads back 0 whatever was sent.
  it("supersedes a mismatched send only while Channex's cut-off closes its night", async () => {
    dependencies.authority.mockResolvedValue({
      kind: "authorized",
      lease: { operationType: "sync_ari", propertyId: "property" },
    });
    const send = { attemptId: "send", roomTypeId: "room", date: "2026-11-18", admissible: true };
    // Channex shows the closed night as 0.
    const mismatch = Object.assign(new Error("availability_readback_mismatch"), {
      observedCount: 0,
    });
    const get = vi.fn();
    const now = () => new Date("2026-11-18T12:52:00Z");
    const pool = pendingPool([send]);
    const run = () => reconcilePendingChannexRoomAvailability(pool, {} as never, lease, get, now);
    dependencies.reconcile.mockReset().mockRejectedValue(mismatch);
    dependencies.supersede.mockReset().mockResolvedValue({ kind: "availability_superseded" });

    dependencies.closed.mockReset().mockResolvedValue(true);
    await expect(run()).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    // The send step's own rule decides whether the night is closed, so the two never disagree.
    expect(dependencies.closed).toHaveBeenCalledExactlyOnceWith(
      pool,
      lease,
      "2026-11-18",
      get,
      now,
    );
    expect(dependencies.supersede).toHaveBeenCalledExactlyOnceWith(pool, {}, lease, "send", get, {
      channexCutOff: true,
    });

    // While the night is open (before the cut-off, or the cut-off unconfirmed), the mismatch stands.
    dependencies.supersede.mockClear();
    dependencies.closed.mockResolvedValueOnce(false);
    await expect(run()).rejects.toBe(mismatch);
    expect(dependencies.supersede).not.toHaveBeenCalled();

    // Any other failure, or a night Channex shows as sellable, never asks for the cut-off.
    dependencies.closed.mockClear();
    for (const failure of [
      new Error("availability_readback_unavailable"),
      Object.assign(new Error("availability_readback_mismatch"), { observedCount: 1 }),
      Object.assign(new Error("availability_readback_mismatch"), { observedCount: null }),
      new Error("availability_readback_mismatch"),
    ]) {
      dependencies.reconcile.mockRejectedValueOnce(failure);
      await expect(run()).rejects.toBe(failure);
    }
    expect(dependencies.closed).not.toHaveBeenCalled();
    expect(dependencies.supersede).not.toHaveBeenCalled();

    // A send that can't be superseded yet is retried, as before.
    dependencies.closed.mockResolvedValue(true);
    dependencies.supersede.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "availability_supersede_unavailable",
    });
    await expect(run()).rejects.toBe(mismatch);
  });
});
