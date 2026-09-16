import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPmsAcceptedPricingReservationWorker,
  startPmsAcceptedPricingReservationWorker,
} from "./pmsAcceptedPricingReservationWorker.js";

describe("accepted-pricing PMS worker runtime", () => {
  afterEach(() => vi.useRealTimers());

  it("runs one job at a time and drains before closing its pool", async () => {
    vi.useFakeTimers();
    let finish!: (outcome: "empty") => void;
    const worker = {
      processNext: vi.fn(() => new Promise<"empty">((resolve) => (finish = resolve))),
      close: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createPmsAcceptedPricingReservationWorker>;
    const runtime = startPmsAcceptedPricingReservationWorker({
      worker,
      warn: vi.fn(),
      intervalMs: 10,
    });

    expect(worker.processNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(worker.processNext).toHaveBeenCalledTimes(1);
    const closing = runtime.close();
    expect(worker.close).not.toHaveBeenCalled();
    finish("empty");
    await closing;
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it("reports terminal jobs and worker failures", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const processNext = vi.fn<() => Promise<"empty" | "dead_lettered">>(async () => "empty");
    processNext
      .mockResolvedValueOnce("dead_lettered")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const worker = {
      processNext,
      close: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createPmsAcceptedPricingReservationWorker>;
    const runtime = startPmsAcceptedPricingReservationWorker({ worker, warn, intervalMs: 10 });

    await vi.advanceTimersByTimeAsync(20);
    expect(warn).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
});
