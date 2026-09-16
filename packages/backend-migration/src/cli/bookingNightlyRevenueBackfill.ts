#!/usr/bin/env node
import pg from "pg";

import { runNightlyRevenueBackfill } from "../bookingNightlyRevenueBackfillMigration.js";
import { normalizePgConnectionString } from "../pgConnection.js";

try {
  const input = parseArgs(process.argv.slice(2));
  if (!input.connectionString)
    throw new Error("TARGET_DATABASE_URL or --connection-string is required");
  if (!input.runId) throw new Error("--run-id is required");
  if (!input.recognizedOn) throw new Error("--recognized-on is required");
  const confirmation = `nightly-revenue-backfill:${input.runId}`;
  if (input.mode === "apply" && input.confirm !== confirmation)
    throw new Error(`--apply requires --confirm ${confirmation}`);

  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(input.connectionString),
    max: 1,
  });
  try {
    const report = await runNightlyRevenueBackfill(pool, input);
    console.log(JSON.stringify(report, null, 2));
    if (input.mode === "dry-run")
      console.log(
        `Dry run only. Review the report, then re-run with --apply --confirm ${confirmation}.`,
      );
    if (report.exceptions.length > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : "Nightly revenue backfill failed"}`,
  );
  process.exitCode = 1;
}

function parseArgs(values: string[]) {
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let runId = "";
  let recognizedOn = "";
  let confirm = "";
  let limit: number | undefined;
  let apply = false;
  let dryRun = false;
  let allowInferredEqualAllocation = false;
  for (let index = 0; index < values.length; index++) {
    const arg = values[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--allow-inferred-equal-allocation") allowInferredEqualAllocation = true;
    else if (arg === "--connection-string") connectionString = requiredValue(values, ++index, arg);
    else if (arg === "--run-id") runId = requiredValue(values, ++index, arg);
    else if (arg === "--recognized-on") recognizedOn = requiredValue(values, ++index, arg);
    else if (arg === "--page-size") limit = Number(requiredValue(values, ++index, arg));
    else if (arg === "--confirm") confirm = requiredValue(values, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (apply && dryRun) throw new Error("Choose either --dry-run or --apply");
  return {
    connectionString,
    runId,
    mode: apply ? ("apply" as const) : ("dry-run" as const),
    recognizedOn,
    allowInferredEqualAllocation,
    ...(limit === undefined ? {} : { limit }),
    confirm,
  };
}

function requiredValue(values: string[], index: number, option: string) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
