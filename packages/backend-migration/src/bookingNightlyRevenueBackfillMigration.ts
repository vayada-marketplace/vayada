import type pg from "pg";

import { planNightlyRevenueBackfill } from "./bookingNightlyRevenueBackfill.js";
import { readUncapturedNightlyRevenueCandidates } from "./bookingNightlyRevenueBackfillReader.js";
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
export type NightlyRevenueBackfillPageServices = {
  read: typeof readUncapturedNightlyRevenueCandidates;
  plan: typeof planNightlyRevenueBackfill;
  apply: typeof applyNightlyRevenueBackfillPage;
};
const services: NightlyRevenueBackfillPageServices = {
  read: readUncapturedNightlyRevenueCandidates,
  plan: planNightlyRevenueBackfill,
  apply: applyNightlyRevenueBackfillPage,
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
    await finish("COMMIT");
    return report(input, page.nextGuestBookingId, page.candidates.length, pageId, plan, write);
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

function report(
  input: NightlyRevenueBackfillPageInput,
  nextGuestBookingId: string | null,
  candidateCount: number,
  pageId: string,
  plan: ReturnType<typeof planNightlyRevenueBackfill>,
  write: Awaited<ReturnType<typeof applyNightlyRevenueBackfillPage>> | null,
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
