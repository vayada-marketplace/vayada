import { describe, expect, it, vi } from "vitest";

import { startAiChangeRecoveryWorker } from "./recoveryWorker.js";

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe("the recovery job of AI changes (VAY-2524)", () => {
  it("closes unanswered changes, takes over runs whose lease ran out, and says so", async () => {
    const executor = { expirePending: vi.fn(async () => 2), recover: vi.fn(async () => 1) };
    const log = logger();
    const worker = startAiChangeRecoveryWorker({ executor, enabled: false, logger: log });
    await worker.runNow();
    expect(executor.expirePending).toHaveBeenCalledOnce();
    expect(executor.recover).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith({ expired: 2, recovered: 1 }, expect.any(String));
    await worker.close();
  });

  it("stays quiet when there is nothing to do, logs a failure and runs one sweep at a time", async () => {
    let release!: () => void;
    const executor = {
      expirePending: vi.fn(() => new Promise<number>((resolve) => (release = () => resolve(0)))),
      recover: vi.fn(async () => 0),
    };
    const log = logger();
    const worker = startAiChangeRecoveryWorker({ executor, enabled: false, logger: log });
    const first = worker.runNow();
    const second = worker.runNow();
    release();
    await Promise.all([first, second]);
    expect(executor.expirePending).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();

    executor.recover.mockRejectedValueOnce(new Error("database down"));
    executor.expirePending.mockResolvedValueOnce(0);
    await worker.runNow();
    expect(log.error).toHaveBeenCalledOnce();
    await worker.close();
    await worker.runNow();
    expect(executor.expirePending).toHaveBeenCalledTimes(2);
  });
});
