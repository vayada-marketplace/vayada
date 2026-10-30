import { describe, expect, it, vi } from "vitest";
import {
  startGuestIdentityRetentionWorker,
  type GuestIdentityRetentionStore,
} from "./guestIdentityRetention.js";

describe("guest identity retention worker (VAY-2420)", () => {
  it("removes batches until one comes back short, for the day it runs, and logs the total", async () => {
    const batches = [
      { profiles: 2, registrations: 0 },
      { profiles: 1, registrations: 1 },
    ];
    const store: GuestIdentityRetentionStore = {
      removeExpiredBatch: vi.fn(async () => batches.shift() ?? { profiles: 0, registrations: 0 }),
      close: vi.fn(async () => undefined),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startGuestIdentityRetentionWorker({
      store,
      enabled: false,
      batchSize: 2,
      now: () => new Date("2027-09-10T23:30:00Z"),
      logger,
    });
    await worker.runNow();
    expect(store.removeExpiredBatch).toHaveBeenCalledTimes(2);
    expect(store.removeExpiredBatch).toHaveBeenCalledWith("2027-09-10", 2);
    expect(logger.info).toHaveBeenCalledWith(
      { profiles: 3, registrations: 1 },
      "Removed expired guest ID documents",
    );
    await worker.close();
    expect(store.close).toHaveBeenCalled();
  });

  it("logs a failed run and tries again next time", async () => {
    const store: GuestIdentityRetentionStore = {
      removeExpiredBatch: vi.fn(async () => {
        throw new Error("lock timeout");
      }),
      close: vi.fn(async () => undefined),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startGuestIdentityRetentionWorker({ store, enabled: false, logger });
    await worker.runNow();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Guest identity retention failed",
    );
    await worker.close();
  });
});
