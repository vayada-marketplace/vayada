#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import pg from "pg";

import {
  parseLegacyHistoricalBindingPreflightInput,
  runLegacyHistoricalBindingPreflight,
} from "../legacyHistoricalBindingPreflightRunner.js";
import { parseChannexAdoptionRunnerConfig } from "../channexAdoptionRunnerConfig.js";
import { normalizePgConnectionString } from "../pgConnection.js";

const [configFile, inputFile, signatureFile] = process.argv.slice(2);
const sourceUrl = process.env["VAY2017_SOURCE_DATABASE_URL"];
const targetUrl = process.env["VAY2017_TARGET_DATABASE_URL"];
const executionPrincipal = process.env["CHANNEX_ADOPTION_EXECUTION_PRINCIPAL"];

if (
  process.argv.length !== 5 ||
  !configFile ||
  !inputFile ||
  !signatureFile ||
  !sourceUrl ||
  !targetUrl ||
  !executionPrincipal
) {
  console.error(
    "Usage: legacyHistoricalBindingPreflight <deployment-config.json> <input.json> <signature>; set both VAY2017 database URLs and CHANNEX_ADOPTION_EXECUTION_PRINCIPAL.",
  );
  process.exit(1);
}

const readOnly = "-c default_transaction_read_only=on -c statement_timeout=10s -c lock_timeout=3s";
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
  const config = parseChannexAdoptionRunnerConfig(
    await readFile(configFile, "utf8"),
    executionPrincipal,
  );
  if (
    config.environment !== "production" ||
    !config.allowedExecutionPrincipals.has(executionPrincipal)
  )
    throw new Error("Preflight runner is not authorized");
  const input = parseLegacyHistoricalBindingPreflightInput(
    await readFile(inputFile, "utf8"),
    (await readFile(signatureFile, "utf8")).trim(),
    config.verificationKeys,
  );
  const report = await runLegacyHistoricalBindingPreflight({ source, target }, input);
  console.log(JSON.stringify(report));
  if (report.status === "blocked") process.exitCode = 2;
} catch {
  // Database and parsing errors may contain credentials or sensitive evidence.
  console.error(
    "Historical binding preflight failed. Check the approved input and read-only database access.",
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
