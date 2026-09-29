#!/usr/bin/env node
import pg from "pg";

import { prepareLegacyHistoricalBindingPreflightInput } from "../legacyHistoricalBindingPreflightPreparation.js";
import { normalizePgConnectionString } from "../pgConnection.js";

const [signingKeyId] = process.argv.slice(2);
const sourceUrl = process.env["VAY2017_SOURCE_DATABASE_URL"];
const targetUrl = process.env["VAY2017_TARGET_DATABASE_URL"];
if (process.argv.length !== 3 || !signingKeyId || !sourceUrl || !targetUrl) {
  console.error(
    "Usage: legacyHistoricalBindingPreflightPrepare <signing-key-id>; set both VAY2017 database URLs.",
  );
  process.exit(1);
}

const readOnly = "-c default_transaction_read_only=on -c statement_timeout=30s -c lock_timeout=3s";
const source = new pg.Pool({
  connectionString: normalizePgConnectionString(sourceUrl),
  options: readOnly,
  max: 1,
  connectionTimeoutMillis: 10_000,
});
const target = new pg.Pool({
  connectionString: normalizePgConnectionString(targetUrl),
  options: readOnly,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  process.stdout.write(
    await prepareLegacyHistoricalBindingPreflightInput({ source, target }, signingKeyId),
  );
} catch {
  console.error(
    "Historical binding preflight preparation failed. Check read-only database access.",
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
