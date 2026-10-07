#!/usr/bin/env node
import { parseArgs } from "node:util";

import pg from "pg";

import { backfillPreactivationOtaCommissions } from "../jobs/financeOtaCommissionPreactivation.js";

const { values } = parseArgs({
  options: {
    "property-id": { type: "string" },
    "apply-for-property": { type: "string" },
    limit: { type: "string" },
  },
});
const propertyId = values["property-id"] ?? "";
const apply = values["apply-for-property"] !== undefined;
if (!process.env["TARGET_DATABASE_URL"] || !propertyId)
  throw new Error("TARGET_DATABASE_URL and --property-id are required");
if (apply && values["apply-for-property"]?.toLowerCase() !== propertyId.toLowerCase())
  throw new Error("--apply-for-property must match --property-id");
const limit = values.limit === undefined ? 25 : Number(values.limit);
const pool = new pg.Pool({ connectionString: process.env["TARGET_DATABASE_URL"], max: 2 });
try {
  const result = await backfillPreactivationOtaCommissions(pool, {
    propertyId,
    apply,
    limit,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (
    result.pendingAfter > 0 ||
    result.counters?.incomplete ||
    result.counters?.deadLettered ||
    result.counters?.retryScheduled
  )
    process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "preactivation_failed" }) +
      "\n",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
