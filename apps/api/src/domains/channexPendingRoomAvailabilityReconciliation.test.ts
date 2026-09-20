import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ authority: vi.fn(), reconcile: vi.fn() }));
vi.mock("./channexPricingPropertyAuthority.js", () => ({
  lockChannexPricingPropertyAuthority: dependencies.authority,
}));
vi.mock("./channexRoomAvailabilityEvidence.js", () => ({
  reconcileCurrentChannexRoomAvailability: dependencies.reconcile,
}));
import { reconcilePendingChannexRoomAvailability } from "./channexPendingRoomAvailabilityReconciliation.js";

describe("pending Channex room availability reconciliation", () => {
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
});
