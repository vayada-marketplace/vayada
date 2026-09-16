import type pg from "pg";

import { planNightlyRevenueBackfill } from "./bookingNightlyRevenueBackfill.js";
import { readUncapturedNightlyRevenueCandidates } from "./bookingNightlyRevenueBackfillReader.js";
import { verifyAppliedNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillVerification.js";
import { applyNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillWriter.js";

type QueryPool = Pick<pg.Pool, "connect">;
export type NightlyRevenueBackfillMode = "dry-run" | "apply";
export type NightlyRevenueBackfillPageInput = {
  runId: string;
  mode: NightlyRevenueBackfillMode;
  recognizedOn: string;
  allowInferredEqualAllocation: boolean;
  afterGuestBookingId?: string;
  limit?: number;
};
export type NightlyRevenueBackfillRunInput = Omit<
  NightlyRevenueBackfillPageInput,
  "afterGuestBookingId"
>;
export type NightlyRevenueBackfillPageServices = {
  read: typeof readUncapturedNightlyRevenueCandidates;
  plan: typeof planNightlyRevenueBackfill;
  apply: typeof applyNightlyRevenueBackfillPage;
  verify: typeof verifyAppliedNightlyRevenueBackfillPage;
};
const services: NightlyRevenueBackfillPageServices = {
  read: readUncapturedNightlyRevenueCandidates,
  plan: planNightlyRevenueBackfill,
  apply: applyNightlyRevenueBackfillPage,
  verify: verifyAppliedNightlyRevenueBackfillPage,
};

/** Acquires and releases one client; one bounded transaction is the safe checkpoint. */
export async function runNightlyRevenueBackfillPage(
  pool: QueryPool,
  input: NightlyRevenueBackfillPageInput,
  dependencies: NightlyRevenueBackfillPageServices = services,
) {
  validate(input);
  const client = await pool.connect();
  let state: "new" | "open" | "closed" | "poisoned" = "new";
  const finish = async (statement: "COMMIT" | "ROLLBACK") => {
    try {
      await client.query(statement);
      state = "closed";
    } catch (error) {
      state = "poisoned";
      throw error;
    }
  };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    state = "open";
    const page = await dependencies.read(client, {
      afterGuestBookingId: input.afterGuestBookingId,
      limit: input.limit,
    });
    const plan = dependencies.plan(page.candidates, {
      allowInferredEqualAllocation: input.allowInferredEqualAllocation,
    });
    const pageId = `${input.runId}:${plan.fingerprint}`;
    if (input.mode === "dry-run" || !page.transactionId) {
      await finish("ROLLBACK");
      return report(input, page.nextGuestBookingId, page.candidates.length, pageId, plan, null);
    }
    const write = await dependencies.apply(
      client,
      { pageId, recognizedOn: input.recognizedOn, lines: plan.lines },
      page.transactionId,
    );
    const verification = await dependencies.verify(client, plan.lines);
    await finish("COMMIT");
    return report(
      input,
      page.nextGuestBookingId,
      page.candidates.length,
      pageId,
      plan,
      write,
      verification,
    );
  } catch (error) {
    if (state === "open") {
      try {
        await finish("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Backfill failed and rollback failed");
      }
    } else if (state === "new") state = "poisoned";
    throw error;
  } finally {
    client.release(state === "poisoned");
  }
}

/** Runs independent committed checkpoints; retry the same run ID to replay completed pages. */
export async function runNightlyRevenueBackfill(
  pool: QueryPool,
  input: NightlyRevenueBackfillRunInput,
  dependencies: NightlyRevenueBackfillPageServices = services,
) {
  const pageReports: Awaited<ReturnType<typeof runNightlyRevenueBackfillPage>>[] = [];
  const cursors = new Set<string>();
  let afterGuestBookingId: string | undefined;
  while (true) {
    const page = await runNightlyRevenueBackfillPage(
      pool,
      { ...input, ...(afterGuestBookingId ? { afterGuestBookingId } : {}) },
      dependencies,
    );
    pageReports.push(page);
    if (!page.nextGuestBookingId) break;
    if (cursors.has(page.nextGuestBookingId))
      throw new Error("Nightly revenue backfill cursor did not advance");
    cursors.add(page.nextGuestBookingId);
    afterGuestBookingId = page.nextGuestBookingId;
  }
  return {
    runId: input.runId,
    mode: input.mode,
    complete: true,
    pageCount: pageReports.length,
    committedPages: pageReports.filter(({ committed }) => committed).length,
    candidateCount: sum(pageReports.map(({ candidateCount }) => candidateCount)),
    lineCount: sum(pageReports.map(({ lineCount }) => lineCount)),
    insertedRows: sum(pageReports.map(({ write }) => write?.insertedCount ?? 0)),
    replayedPages: pageReports.filter(({ write }) => write?.outcome === "replayed").length,
    exceptions: pageReports.flatMap(({ exceptions }) => exceptions),
    plannedReconciliation: aggregatePlanned(
      pageReports.flatMap(({ reconciliation }) => reconciliation),
    ),
    appliedReconciliation: aggregateApplied(
      pageReports.flatMap(({ verification }) => verification?.reconciliation ?? []),
    ),
    pageReports,
  };
}

function report(
  input: NightlyRevenueBackfillPageInput,
  nextGuestBookingId: string | null,
  candidateCount: number,
  pageId: string,
  plan: ReturnType<typeof planNightlyRevenueBackfill>,
  write: Awaited<ReturnType<typeof applyNightlyRevenueBackfillPage>> | null,
  verification: Awaited<ReturnType<typeof verifyAppliedNightlyRevenueBackfillPage>> | null = null,
) {
  return {
    runId: input.runId,
    mode: input.mode,
    committed: write !== null,
    pageId,
    nextGuestBookingId,
    candidateCount,
    lineCount: plan.lines.length,
    fingerprint: plan.fingerprint,
    exceptions: plan.exceptions,
    reconciliation: plan.reconciliation,
    write,
    verification,
  };
}

function validate(input: NightlyRevenueBackfillPageInput) {
  if (
    !/^vay1181-[0-9a-f]{24}$/.test(input.runId) ||
    !validDate(input.recognizedOn) ||
    typeof input.allowInferredEqualAllocation !== "boolean" ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000)) ||
    (input.afterGuestBookingId !== undefined && !UUID.test(input.afterGuestBookingId)) ||
    (input.mode !== "dry-run" && input.mode !== "apply")
  )
    throw new Error("Nightly revenue backfill page input is malformed");
}
const validDate = (value: string) =>
  DATE.test(value) &&
  !value.startsWith("0000-") &&
  new Date(value).toJSON() === `${value}T00:00:00.000Z`;
const DATE = /^\d{4}-\d{2}-\d{2}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Planned = ReturnType<typeof planNightlyRevenueBackfill>["reconciliation"][number];
type Applied = Awaited<
  ReturnType<typeof verifyAppliedNightlyRevenueBackfillPage>
>["reconciliation"][number];
function aggregatePlanned(rows: Planned[]) {
  const groups = new Map<string, Planned>();
  for (const row of rows) {
    const id = groupKey(row),
      current = groups.get(id);
    groups.set(
      id,
      current
        ? {
            ...current,
            bookingCount: current.bookingCount + row.bookingCount,
            evidenceRows: current.evidenceRows + row.evidenceRows,
            occupiedRoomNights: current.occupiedRoomNights + row.occupiedRoomNights,
            grossRoomAmount: addMoney(current.grossRoomAmount, row.grossRoomAmount),
            missingRows: current.missingRows + row.missingRows,
          }
        : { ...row },
    );
  }
  return ordered(groups);
}
function aggregateApplied(rows: Applied[]) {
  const groups = new Map<string, Applied>();
  for (const row of rows) {
    const id = groupKey(row),
      current = groups.get(id);
    groups.set(
      id,
      current
        ? {
            ...current,
            bookingCount: current.bookingCount + row.bookingCount,
            roomNightCount: current.roomNightCount + row.roomNightCount,
            revisionCount: current.revisionCount + row.revisionCount,
            storedRows: current.storedRows + row.storedRows,
            occupiedRoomNights: current.occupiedRoomNights + row.occupiedRoomNights,
            grossRoomAmount: addMoney(current.grossRoomAmount, row.grossRoomAmount),
            missingRoomNights: current.missingRoomNights + row.missingRoomNights,
          }
        : { ...row },
    );
  }
  return ordered(groups);
}
const groupKey = (row: {
  propertyId: string;
  stayDate: string;
  currency: string;
  sourceKind: string;
  evidenceQuality: string;
}) => `${row.propertyId}:${row.stayDate}:${row.currency}:${row.sourceKind}:${row.evidenceQuality}`;
const ordered = <T>(groups: Map<string, T>) =>
  [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const addMoney = (left: string, right: string) => formatMoney(money(left) + money(right));
const money = (value: string) => BigInt(value.replace(".", ""));
const formatMoney = (value: bigint) =>
  `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 10_000n}.${((value < 0n ? -value : value) % 10_000n).toString().padStart(4, "0")}`;
