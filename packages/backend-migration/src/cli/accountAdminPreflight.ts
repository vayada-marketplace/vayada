#!/usr/bin/env node
import pg from "pg";
import { runAccountAdminPreflight } from "../accountAdminPreflight.js";
import { normalizePgConnectionString } from "../pgConnection.js";

const connectionString = process.env["TARGET_DATABASE_URL"];
if (!connectionString || process.argv.length > 2) {
  console.error("Set TARGET_DATABASE_URL; this read-only command accepts no arguments.");
  process.exit(1);
}
let client: pg.Client | undefined;
try {
  client = new pg.Client({ connectionString: normalizePgConnectionString(connectionString) });
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  const report = await runAccountAdminPreflight(client);
  await client.query("COMMIT");
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 1;
} catch {
  // Connection errors may contain credentials; do not print raw driver errors.
  console.error("Account-admin preflight failed. Check database access and required migrations.");
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}
