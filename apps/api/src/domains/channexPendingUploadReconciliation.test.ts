import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
const owners = vi.hoisted(() => ({ read: vi.fn(), reconcile: vi.fn(), release: vi.fn() }));
vi.mock("./replacementPricingOfferOwners.js", () => ({
  readPublishedPricingForChannexJob: owners.read,
  reconcileCurrentChannexInitialAri: owners.reconcile,
}));
vi.mock("./channexInitialAriRelease.js", () => ({
  releaseUnansweredChannexInitialAri: owners.release,
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
      return { kind: id === "attempt-10" ? "ari_retired" : "ari_reconciled" };
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

  // VAY-2108: Tiga's upload with no saved Channex reply stopped every later sync (2026-11-16).
  it.each([
    ["released", { kind: "ari_released" }, { kind: "pending_uploads_reconciled", count: 2 }],
    [
      "resolved meanwhile",
      { kind: "ari_attempt_resolved" },
      { kind: "pending_uploads_reconciled", count: 2 },
    ],
    [
      "settling",
      { kind: "unavailable", reason: "ari_send_settling" },
      { kind: "unavailable", reason: "ari_send_settling" },
    ],
    [
      "contended",
      { kind: "unavailable", reason: "ari_release_contention" },
      { kind: "unavailable", reason: "ari_release_contention" },
    ],
    [
      "a refusal",
      { kind: "unavailable", reason: "ari_reply_kept" },
      { kind: "unavailable", reason: "ari_receipt_history_unavailable" },
    ],
  ])(
    "releases an unanswered upload only through the release step (%s)",
    async (_case, release, expected) => {
      owners.read.mockResolvedValue({
        kind: "available",
        authority: { lease: { propertyId: "property" } },
      });
      owners.reconcile.mockReset();
      owners.reconcile.mockImplementation(async (_pool, _lease, _selection, _creation, id) =>
        id === "unanswered"
          ? { kind: "unavailable", reason: "ari_receipt_history_unavailable" }
          : { kind: "ari_reconciled" },
      );
      owners.release.mockReset();
      owners.release.mockResolvedValue(release);
      const rows = ["unanswered", "answered"].map((attemptId) => ({
        attemptId,
        creationAttemptId: `creation-${attemptId}`,
        roomTypeId: "room",
        offerId: "offer",
        operationKey: "operation",
        primaryOccupancy: 2,
      }));
      const pool = { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
      const lease = { jobId: "job", workerId: "worker", attemptNumber: 2 };
      expect(await reconcilePendingChannexUploads(pool, lease, vi.fn())).toEqual(expected);
      expect(owners.release).toHaveBeenCalledExactlyOnceWith(pool, lease, "unanswered");
      expect(owners.reconcile).toHaveBeenCalledTimes(expected.kind === "unavailable" ? 1 : 2);
    },
  );
  it("does not release an upload that stopped for any other reason", async () => {
    owners.read.mockResolvedValue({
      kind: "available",
      authority: { lease: { propertyId: "property" } },
    });
    owners.reconcile.mockReset();
    owners.reconcile.mockResolvedValue({
      kind: "unavailable",
      reason: "ari_reconciliation_required",
    });
    owners.release.mockReset();
    const rows = [
      {
        attemptId: "a",
        creationAttemptId: "c",
        roomTypeId: "r",
        offerId: "o",
        operationKey: "k",
        primaryOccupancy: 1,
      },
    ];
    const pool = { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
    expect(
      await reconcilePendingChannexUploads(
        pool,
        { jobId: "job", workerId: "w", attemptNumber: 1 },
        vi.fn(),
      ),
    ).toEqual({ kind: "unavailable", reason: "ari_reconciliation_required" });
    expect(owners.release).not.toHaveBeenCalled();
  });
});
