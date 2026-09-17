#!/usr/bin/env node
import pg from "pg";

import { runFinancialsActivationReadiness } from "../financialsActivationReadiness.js";
import { normalizePgConnectionString } from "../pgConnection.js";

const args = process.argv.slice(2);
let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
let propertyId = "";
let expectedModuleState: "active" | "inactive" = "inactive";
let pretty = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--connection-string") connectionString = value(args, ++index, arg);
  else if (arg === "--property-id") propertyId = value(args, ++index, arg);
  else if (arg === "--expect-active") expectedModuleState = "active";
  else if (arg === "--expect-inactive") expectedModuleState = "inactive";
  else if (arg === "--pretty") pretty = true;
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!connectionString || !propertyId)
  throw new Error("TARGET_DATABASE_URL and --property-id are required");

const client = new pg.Client({ connectionString: normalizePgConnectionString(connectionString) });
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const report = await runFinancialsActivationReadiness(client, {
    propertyId,
    expectedModuleState,
  });
  await client.query("COMMIT");
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
  if (report.status === "blocked") process.exitCode = 2;
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`Error: ${error instanceof Error ? error.message : "Readiness audit failed"}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

function value(values: string[], index: number, option: string) {
  const result = values[index];
  if (!result || result.startsWith("--")) throw new Error(`${option} requires a value`);
  return result;
}
