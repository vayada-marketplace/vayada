import { describe, expect, it, vi } from "vitest";

import { startAiActionLogRetentionWorker } from "./aiActionLogRetention.js";

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe("AI action log retention worker", () => {
  it("drains full batches of any kind, then stops", async () => {
    const batches = [
      { logRows: 2, assistResults: 0, conversations: 0, operations: 0 },
      { logRows: 0, assistResults: 2, conversations: 0, operations: 0 },
      { logRows: 0, assistResults: 0, conversations: 2, operations: 0 },
      { logRows: 0, assistResults: 0, conversations: 0, operations: 2 },
      { logRows: 1, assistResults: 0, conversations: 1, operations: 1 },
    ];
    const purgeExpiredBatch = vi.fn(async () => batches.shift()!);
    const log = logger();
    const worker = startAiActionLogRetentionWorker({
      store: { purgeExpiredBatch, close: vi.fn(async () => undefined) },
      enabled: false,
      batchSize: 2,
      now: () => new Date("2028-12-01T00:00:00.000Z"),
      logger: log,
    });
    await worker.runNow();
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(5);
    expect(purgeExpiredBatch).toHaveBeenCalledWith(new Date("2028-12-01T00:00:00.000Z"), 2);
    expect(log.info).toHaveBeenCalledWith(
      { logRows: 3, assistResults: 2, conversations: 3, operations: 3 },
      expect.any(String),
    );
    await worker.close();
  });

  it("logs a failure without throwing and closes its store", async () => {
    const close = vi.fn(async () => undefined);
    const log = logger();
    const worker = startAiActionLogRetentionWorker({
      store: { purgeExpiredBatch: async () => Promise.reject(new Error("db down")), close },
      enabled: false,
      logger: log,
    });
    await worker.runNow();
    expect(log.error).toHaveBeenCalledTimes(1);
    await worker.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
