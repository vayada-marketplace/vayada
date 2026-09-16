import { describe, expect, it, vi } from "vitest";

import {
  runNightlyRevenueBackfill,
  runNightlyRevenueBackfillPage,
  type NightlyRevenueBackfillPageInput,
  type NightlyRevenueBackfillPageServices,
} from "./bookingNightlyRevenueBackfillMigration.js";
import type { NightlyRevenueBackfillLine } from "./bookingNightlyRevenueBackfill.js";

const RUN = "vay1181-0123456789abcdef01234567";
const CURSOR = "11810000-0000-4000-8000-000000000010";
const FINGERPRINT = "a".repeat(64);
const input: NightlyRevenueBackfillPageInput = {
  runId: RUN,
  mode: "dry-run",
  recognizedOn: "2026-09-17",
  allowInferredEqualAllocation: false,
  afterGuestBookingId: CURSOR,
  limit: 25,
};

describe("nightly revenue backfill page transaction", () => {
  it("plans a dry run and always rolls it back without invoking the writer", async () => {
    const client = new TransactionFixture();
    const pool = new PoolFixture(client);
    const dependencies = fixture();
    const result = await runNightlyRevenueBackfillPage(pool as never, input, dependencies);
    expect(result).toMatchObject({
      runId: RUN,
      mode: "dry-run",
      committed: false,
      pageId: `${RUN}:${FINGERPRINT}`,
      candidateCount: 1,
      lineCount: 1,
      nextGuestBookingId: CURSOR,
      write: null,
    });
    expect(client.sql).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"]);
    expect(client.releasedWith).toEqual([false]);
    expect(dependencies.read).toHaveBeenCalledWith(client, {
      afterGuestBookingId: CURSOR,
      limit: 25,
    });
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(dependencies.verify).not.toHaveBeenCalled();
  });

  it("applies and commits one page using the reader transaction token", async () => {
    const client = new TransactionFixture();
    const pool = new PoolFixture(client);
    const dependencies = fixture();
    const result = await runNightlyRevenueBackfillPage(
      pool as never,
      { ...input, mode: "apply" },
      dependencies,
    );
    expect(result).toMatchObject({ committed: true, write: { outcome: "appended" } });
    expect(client.sql).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
    expect(client.releasedWith).toEqual([false]);
    expect(dependencies.apply).toHaveBeenCalledWith(
      client,
      { pageId: `${RUN}:${FINGERPRINT}`, recognizedOn: "2026-09-17", lines: [line] },
      "reader-transaction",
    );
    expect(dependencies.verify).toHaveBeenCalledWith(client, [line]);
  });

  it("rolls back failures and treats an empty page as a completed dry checkpoint", async () => {
    const failedClient = new TransactionFixture();
    const failedPool = new PoolFixture(failedClient);
    const failed = fixture();
    failed.apply = vi.fn(async () => {
      throw new Error("write failed");
    });
    await expect(
      runNightlyRevenueBackfillPage(failedPool as never, { ...input, mode: "apply" }, failed),
    ).rejects.toThrow("write failed");
    expect(failedClient.sql.at(-1)).toBe("ROLLBACK");
    expect(failedClient.releasedWith).toEqual([false]);

    const verificationClient = new TransactionFixture();
    const verificationFailed = fixture();
    verificationFailed.verify = vi.fn(async () => {
      throw new Error("verification failed");
    });
    await expect(
      runNightlyRevenueBackfillPage(
        new PoolFixture(verificationClient) as never,
        { ...input, mode: "apply" },
        verificationFailed,
      ),
    ).rejects.toThrow("verification failed");
    expect(verificationClient.sql.at(-1)).toBe("ROLLBACK");

    const poisonedClient = new TransactionFixture(true);
    const poisonedPool = new PoolFixture(poisonedClient);
    await expect(
      runNightlyRevenueBackfillPage(poisonedPool as never, { ...input, mode: "apply" }, failed),
    ).rejects.toThrow("Backfill failed and rollback failed");
    expect(poisonedClient.releasedWith).toEqual([true]);

    const commitClient = new TransactionFixture(false, true);
    const commitPool = new PoolFixture(commitClient);
    await expect(
      runNightlyRevenueBackfillPage(commitPool as never, { ...input, mode: "apply" }, fixture()),
    ).rejects.toThrow("commit failed");
    expect(commitClient.releasedWith).toEqual([true]);

    const emptyClient = new TransactionFixture();
    const emptyPool = new PoolFixture(emptyClient);
    const empty = fixture();
    empty.read = vi.fn(async () => ({
      candidates: [],
      nextGuestBookingId: null,
      transactionId: null,
    }));
    const result = await runNightlyRevenueBackfillPage(
      emptyPool as never,
      { ...input, mode: "apply" },
      empty,
    );
    expect(result).toMatchObject({ committed: false, candidateCount: 0, write: null });
    expect(empty.apply).not.toHaveBeenCalled();
    expect(emptyClient.sql.at(-1)).toBe("ROLLBACK");
    expect(emptyClient.releasedWith).toEqual([false]);
  });

  it.each([{ runId: "latest" }, { limit: 0 }, { limit: 1_001 }])(
    "rejects malformed input before opening a transaction: %j",
    async (invalid) => {
      const client = new TransactionFixture();
      const pool = new PoolFixture(client);
      await expect(
        runNightlyRevenueBackfillPage(pool as never, {
          ...input,
          ...invalid,
        }),
      ).rejects.toThrow("input is malformed");
      expect(pool.connects).toBe(0);
      expect(client.sql).toEqual([]);
    },
  );
});

describe("nightly revenue backfill run", () => {
  it("runs resumable pages and emits one aggregated reconciliation report", async () => {
    const pool = new MultiPoolFixture();
    const dependencies = fixture();
    const secondCursor = "11810000-0000-4000-8000-000000000011";
    dependencies.read = vi
      .fn()
      .mockResolvedValueOnce({
        candidates: [{} as never],
        nextGuestBookingId: CURSOR,
        transactionId: "transaction-1",
      })
      .mockResolvedValueOnce({
        candidates: [{} as never],
        nextGuestBookingId: secondCursor,
        transactionId: "transaction-2",
      })
      .mockResolvedValueOnce({ candidates: [], nextGuestBookingId: null, transactionId: null });
    dependencies.plan = vi
      .fn()
      .mockReturnValueOnce(
        planFixture(line, "10.0000", [
          {
            propertyId: line.propertyId,
            guestBookingId: line.guestBookingId,
            code: "missing_evidence",
          },
        ]),
      )
      .mockReturnValueOnce(planFixture({ ...line, guestBookingId: secondCursor }, "20.0000"))
      .mockReturnValueOnce(planFixture(null, "0.0000"));
    dependencies.apply = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "appended",
        requestFingerprint: "c".repeat(64),
        bookingCount: 1,
        insertedCount: 1,
        sourceRevisions: { [CURSOR]: 1 },
      })
      .mockResolvedValueOnce({
        outcome: "replayed",
        requestFingerprint: "d".repeat(64),
        bookingCount: 1,
        insertedCount: 0,
        sourceRevisions: { [secondCursor]: 1 },
      });
    dependencies.verify = vi
      .fn()
      .mockResolvedValueOnce(verificationFixture("10.0000"))
      .mockResolvedValueOnce(verificationFixture("20.0000"));

    const result = await runNightlyRevenueBackfill(pool as never, runInput("apply"), dependencies);

    expect(result).toMatchObject({
      complete: true,
      pageCount: 3,
      committedPages: 2,
      candidateCount: 2,
      lineCount: 2,
      insertedRows: 1,
      replayedPages: 1,
    });
    expect(result.exceptions).toEqual([
      {
        propertyId: line.propertyId,
        guestBookingId: line.guestBookingId,
        code: "missing_evidence",
      },
    ]);
    expect(result.plannedReconciliation).toEqual([
      expect.objectContaining({ bookingCount: 2, evidenceRows: 2, grossRoomAmount: "30.0000" }),
    ]);
    expect(result.appliedReconciliation).toEqual([
      expect.objectContaining({ bookingCount: 2, storedRows: 2, grossRoomAmount: "30.0000" }),
    ]);
    expect(
      vi.mocked(dependencies.read).mock.calls.map(([, options]) => options?.afterGuestBookingId),
    ).toEqual([undefined, CURSOR, secondCursor]);
    expect(pool.clients).toHaveLength(3);
    expect(pool.clients.every(({ releasedWith }) => releasedWith[0] === false)).toBe(true);
  });
});

class TransactionFixture {
  sql: string[] = [];
  releasedWith: boolean[] = [];
  private released = false;
  constructor(
    private readonly failRollback = false,
    private readonly failCommit = false,
  ) {}
  async query(sql: string) {
    this.sql.push(sql);
    if (sql === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (sql === "COMMIT" && this.failCommit) throw new Error("commit failed");
    return { rows: [], rowCount: 0 };
  }
  release(destroy = false) {
    if (this.released) throw new Error("released twice");
    this.released = true;
    this.releasedWith.push(destroy);
  }
}
class PoolFixture {
  connects = 0;
  constructor(readonly client: TransactionFixture) {}
  async connect() {
    this.connects++;
    return this.client;
  }
}
class MultiPoolFixture {
  clients: TransactionFixture[] = [];
  async connect() {
    const client = new TransactionFixture();
    this.clients.push(client);
    return client;
  }
}

const line = {
  propertyId: "11810000-0000-4000-8000-000000000001",
  guestBookingId: CURSOR,
  roomTypeId: "11810000-0000-4000-8000-000000000020",
  stayDate: "2026-09-14",
  currency: "EUR",
  grossRoomAmount: null,
  linePosition: 1,
  lifecycleState: "confirmed",
  sourceKind: "migration",
  evidenceQuality: "missing",
  evidenceFingerprint: "b".repeat(64),
} as const;
function fixture(): NightlyRevenueBackfillPageServices {
  return {
    read: vi.fn(async () => ({
      candidates: [{} as never],
      nextGuestBookingId: CURSOR,
      transactionId: "reader-transaction",
    })),
    plan: vi.fn(() => ({
      fingerprint: FINGERPRINT,
      lines: [line],
      exceptions: [],
      reconciliation: [],
    })),
    apply: vi.fn(async () => ({
      outcome: "appended" as const,
      requestFingerprint: "c".repeat(64),
      bookingCount: 1,
      insertedCount: 1,
      sourceRevisions: { [CURSOR]: 1 },
    })),
    verify: vi.fn(async () => ({
      lineCount: 1,
      storedRows: 1,
      revisionCount: 1,
      reconciliation: [],
    })),
  };
}

function planFixture(
  plannedLine: NightlyRevenueBackfillLine | null,
  grossRoomAmount: string,
  exceptions: Array<{ propertyId: string; guestBookingId: string; code: "missing_evidence" }> = [],
) {
  return {
    fingerprint: FINGERPRINT,
    lines: plannedLine ? [plannedLine] : [],
    exceptions,
    reconciliation: plannedLine
      ? [
          {
            propertyId: plannedLine.propertyId,
            stayDate: plannedLine.stayDate,
            currency: plannedLine.currency,
            sourceKind: plannedLine.sourceKind,
            evidenceQuality: plannedLine.evidenceQuality,
            bookingCount: 1,
            evidenceRows: 1,
            occupiedRoomNights: 1,
            grossRoomAmount,
            missingRows: 1,
          },
        ]
      : [],
  };
}

function runInput(mode: "dry-run" | "apply" = "dry-run") {
  return {
    runId: RUN,
    mode,
    recognizedOn: input.recognizedOn,
    allowInferredEqualAllocation: input.allowInferredEqualAllocation,
    limit: input.limit,
  };
}

function verificationFixture(grossRoomAmount: string) {
  return {
    lineCount: 1,
    storedRows: 1,
    revisionCount: 1,
    reconciliation: [
      {
        propertyId: line.propertyId,
        stayDate: line.stayDate,
        currency: line.currency,
        sourceKind: line.sourceKind,
        evidenceQuality: line.evidenceQuality,
        bookingCount: 1,
        roomNightCount: 1,
        revisionCount: 1,
        storedRows: 1,
        occupiedRoomNights: 1,
        grossRoomAmount,
        missingRoomNights: 1,
      },
    ],
  };
}
