#!/usr/bin/env node
import pg from "pg";

import { seedFinancialsDefaultCategories } from "../financialsDefaultCategorySeed.js";
import { normalizePgConnectionString } from "../pgConnection.js";

try {
  const args = process.argv.slice(2);
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let propertyId = "";
  let confirm = "";
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--connection-string") connectionString = value(args, ++index, arg);
    else if (arg === "--property-id") propertyId = value(args, ++index, arg);
    else if (arg === "--confirm") confirm = value(args, ++index, arg);
    else if (arg === "--apply") apply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!connectionString || !propertyId)
    throw new Error("TARGET_DATABASE_URL and --property-id are required");
  if (apply && confirm !== `financials-categories:${propertyId.toLowerCase()}`)
    throw new Error(`--apply requires --confirm financials-categories:${propertyId.toLowerCase()}`);

  const client = new pg.Client({ connectionString: normalizePgConnectionString(connectionString) });
  try {
    await client.connect();
    const report = await seedFinancialsDefaultCategories(client, { propertyId, apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.missingAfter.length) process.exitCode = 2;
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Category seed failed"}`);
  process.exitCode = 1;
}

function value(values: string[], index: number, option: string) {
  const result = values[index];
  if (!result || result.startsWith("--")) throw new Error(`${option} requires a value`);
  return result;
}
