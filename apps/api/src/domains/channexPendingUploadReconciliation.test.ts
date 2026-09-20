import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
const owners = vi.hoisted(() => ({ read: vi.fn(), reconcile: vi.fn() }));
vi.mock("./replacementPricingOfferOwners.js", () => ({
  readPublishedPricingForChannexJob: owners.read,
  reconcileCurrentChannexInitialAri: owners.reconcile,
}));
import { reconcilePendingChannexUploads } from "./channexPendingUploadReconciliation.js";

describe("pending Channex upload batch continuation", () => {
  it("handles ten of eleven candidates, then skips completed attempts on continuation", async () => {
    const pending = new Set(Array.from({ length: 11 }, (_, i) => `attempt-${i}`));
    owners.read.mockResolvedValue({
      kind: "available",
      authority: { lease: { propertyId: "property" } },
    });
    owners.reconcile.mockImplementation(async (_pool, _lease, _selection, _creation, id) => {
      expect(pending.delete(id)).toBe(true);
      return { kind: "ari_reconciled" };
    });
    const query = vi.fn(async (_sql, values) => {
      expect(values).toEqual(["property"]);
      return {
        rows: [...pending].map((attemptId) => ({
          attemptId,
          creationAttemptId: `creation-${attemptId}`,
          roomTypeId: "room",
          offerId: "offer",
          operationKey: "operation",
          primaryOccupancy: 2,
        })),
      };
    });
    const pool = { query } as unknown as Pool;
    const lease = { jobId: "job", workerId: "worker", attemptNumber: 1 };
    const get = vi.fn();
    owners.reconcile.mockClear();
    expect(await reconcilePendingChannexUploads(pool, lease, get)).toEqual({
      kind: "unavailable",
      reason: "reconciliation_batch_pending",
    });
    expect(owners.reconcile).toHaveBeenCalledTimes(10);
    expect(pending.size).toBe(1);
    expect(await reconcilePendingChannexUploads(pool, lease, get)).toEqual({
      kind: "pending_uploads_reconciled",
      count: 1,
    });
    expect(owners.reconcile).toHaveBeenCalledTimes(11);
    expect(await reconcilePendingChannexUploads(pool, lease, get)).toEqual({
      kind: "pending_uploads_reconciled",
      count: 0,
    });
    expect(owners.reconcile).toHaveBeenCalledTimes(11);
  });
});
