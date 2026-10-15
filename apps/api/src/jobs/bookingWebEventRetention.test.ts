import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPgBookingWebEventRetentionStore,
  startBookingWebEventRetentionWorker,
  type BookingWebEventRetentionPool,
  type BookingWebEventRetentionStore,
} from "./bookingWebEventRetention.js";

afterEach(() => {
  vi.useRealTimers();
});

const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("booking web event retention", () => {
  it("deletes an oldest-first batch older than 13 months together with its audit row", async () => {
    const query = vi
      .fn<BookingWebEventRetentionPool["query"]>()
      .mockResolvedValueOnce({ rows: [{ deleted: 2 }] })
      .mockResolvedValueOnce({ rows: [{ deleted: 0 }] });
    const store = createPgBookingWebEventRetentionStore({
      connectionString: "postgresql://retention.invalid/vayada",
      pool: { query, end: vi.fn(async () => undefined) },
    });

    await expect(store.deleteExpiredBatch(NOW, 2)).resolves.toBe(2);
    await expect(store.deleteExpiredBatch(NOW, 2)).resolves.toBe(0);

    const [statement, values] = query.mock.calls[0]!;
    expect(statement).toContain("WHERE occurred_at < $1::timestamptz - $3::text::interval");
    expect(statement).toContain("ORDER BY occurred_at ASC, id ASC");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    expect(statement).toContain("DELETE FROM distribution.booking_web_events AS event");
    expect(statement).toContain("'booking_web.events.retention_purged'");
    expect(statement).toContain("HAVING count(*) > 0");
    expect(statement).toContain("SELECT count(*)::integer AS deleted FROM deleted");
    expect(statement).not.toContain("RETURNING (redacted_payload");
    expect(values).toEqual([
      NOW.toISOString(),
      2,
      "13 months",
      expect.stringMatching(/^booking-web-event-retention:[0-9a-f-]{36}$/),
    ]);
    expect(query.mock.calls[1]![1]![3]).not.toBe(values![3]);
    await expect(store.deleteExpiredBatch(NOW, 0)).rejects.toThrow("positive integer");
  });

  it("drains full batches, then logs the total once", async () => {
    const deleteExpiredBatch = vi
      .fn<BookingWebEventRetentionStore["deleteExpiredBatch"]>()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startBookingWebEventRetentionWorker({
      store: fakeStore(deleteExpiredBatch),
      enabled: false,
      intervalMs: 1_000,
      batchSize: 3,
      now: () => NOW,
      logger,
    });

    await worker.runNow();
    expect(deleteExpiredBatch).toHaveBeenCalledTimes(3);
    expect(deleteExpiredBatch).toHaveBeenLastCalledWith(NOW, 3);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith({ deleted: 7 }, "Deleted expired booking web events");

    deleteExpiredBatch.mockResolvedValueOnce(0);
    await worker.runNow();
    expect(logger.info).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("runs at start and on the interval without overlapping", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const deleteExpiredBatch = vi
      .fn<BookingWebEventRetentionStore["deleteExpiredBatch"]>()
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => (releaseFirst = () => resolve(0))),
      )
      .mockResolvedValue(0);
    const store = fakeStore(deleteExpiredBatch);
    const worker = startBookingWebEventRetentionWorker({
      store,
      enabled: true,
      intervalMs: 1_000,
      now: () => NOW,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
    releaseFirst();
    await worker.runNow();
    await worker.runNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleteExpiredBatch).toHaveBeenCalledTimes(3);
    expect(deleteExpiredBatch).toHaveBeenLastCalledWith(NOW, 1_000);
    await worker.close();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("does not run when disabled and logs failures instead of throwing", async () => {
    vi.useFakeTimers();
    const deleteExpiredBatch = vi
      .fn<BookingWebEventRetentionStore["deleteExpiredBatch"]>()
      .mockRejectedValue(new Error("relation does not exist"));
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startBookingWebEventRetentionWorker({
      store: fakeStore(deleteExpiredBatch),
      enabled: false,
      intervalMs: 1_000,
      logger,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deleteExpiredBatch).not.toHaveBeenCalled();
    await expect(worker.runNow()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Booking web event retention failed",
    );
    await worker.close();
  });

  it("rejects intervals Node timers cannot hold and empty batches", () => {
    const options = {
      store: fakeStore(vi.fn()),
      enabled: false,
      logger: { info() {}, error() {} },
    };
    expect(() => startBookingWebEventRetentionWorker({ ...options, intervalMs: 0 })).toThrow(
      "interval must be between 1 and 2147483647",
    );
    expect(() =>
      startBookingWebEventRetentionWorker({ ...options, intervalMs: 2_147_483_648 }),
    ).toThrow("interval must be between 1 and 2147483647");
    expect(() =>
      startBookingWebEventRetentionWorker({ ...options, intervalMs: 1_000, batchSize: 0 }),
    ).toThrow("batch size must be a positive integer");
  });
});

function fakeStore(
  deleteExpiredBatch: BookingWebEventRetentionStore["deleteExpiredBatch"],
): BookingWebEventRetentionStore & { close: ReturnType<typeof vi.fn> } {
  return { deleteExpiredBatch, close: vi.fn(async () => undefined) };
}
