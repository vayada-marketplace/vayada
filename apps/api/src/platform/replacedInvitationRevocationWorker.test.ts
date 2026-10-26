import { describe, expect, it, vi } from "vitest";

import { startReplacedInvitationRevocationWorker } from "./replacedInvitationRevocationWorker.js";

describe("startReplacedInvitationRevocationWorker", () => {
  it("runs the sweep at start and warns while a revoke still fails", async () => {
    const revokeReplacedInvitations = vi
      .fn<() => Promise<"revoked" | "failed" | undefined>>()
      .mockResolvedValueOnce("failed")
      .mockResolvedValueOnce("revoked");
    const warn = vi.fn();
    const worker = startReplacedInvitationRevocationWorker({
      delivery: { revokeReplacedInvitations },
      warn,
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    await worker.runNow();

    expect(revokeReplacedInvitations).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("does not overlap runs, survives a thrown sweep and stops on close", async () => {
    let finish!: () => void;
    const revokeReplacedInvitations = vi
      .fn<() => Promise<"revoked" | "failed" | undefined>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(undefined);
          }),
      );
    const warn = vi.fn();
    const worker = startReplacedInvitationRevocationWorker({
      delivery: { revokeReplacedInvitations },
      warn,
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        "Replaced invitation revocation worker failed",
      ),
    );

    const first = worker.runNow();
    const overlapping = worker.runNow();
    expect(revokeReplacedInvitations).toHaveBeenCalledTimes(2);
    const closing = worker.close();
    finish();
    await Promise.all([first, overlapping, closing]);
    await worker.runNow();
    expect(revokeReplacedInvitations).toHaveBeenCalledTimes(2);
  });
});
