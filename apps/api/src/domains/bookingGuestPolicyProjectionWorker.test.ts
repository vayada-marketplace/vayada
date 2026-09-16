import { afterEach, describe, expect, it, vi } from "vitest";

import { startBookingGuestPolicyProjectionWorker } from "./bookingGuestPolicyProjectionWorker.js";

describe("Booking guest-policy projection worker", () => {
  afterEach(() => vi.useRealTimers());

  it("drains an active batch before closing its shared database pool", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const runBatch = vi.fn(
      () =>
        new Promise<{
          processed: number;
          applied: number;
          conflicts: number;
          canceled: number;
          retrying: number;
          deadLettered: number;
        }>((resolve) => {
          finish = () =>
            resolve({
              processed: 1,
              applied: 1,
              conflicts: 0,
              canceled: 0,
              retrying: 0,
              deadLettered: 0,
            });
        }),
    );
    const worker = startBookingGuestPolicyProjectionWorker({
      projector: { runBatch },
      workerId: "shutdown-test",
      warn: vi.fn(),
      intervalMs: 10,
    });
    expect(runBatch).toHaveBeenCalledOnce();

    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    finish?.();
    await closing;
    await vi.advanceTimersByTimeAsync(30);
    expect(runBatch).toHaveBeenCalledOnce();
  });
});
