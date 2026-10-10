#!/usr/bin/env node
import { parseArgs } from "node:util";

import pg from "pg";

import { readPricingPublicationFreshness } from "../domains/pricingPublicationFreshness.js";

// Read-only: every transaction is rolled back. Exit 2 when any publication is stale or unreadable.
const { values } = parseArgs({ options: { "property-id": { type: "string" } } });
if (!process.env["TARGET_DATABASE_URL"]) throw new Error("TARGET_DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env["TARGET_DATABASE_URL"], max: 2 });
try {
  const report = await readPricingPublicationFreshness(pool, values["property-id"]);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.some((row) => "error" in row || row.stale.length > 0)) process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "freshness_failed" }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
