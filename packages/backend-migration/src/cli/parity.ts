#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runParityChecks } from "../parity.js";
import { MIGRATION_ENVIRONMENTS, type MigrationEnvironment } from "../runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(__dirname, "../../fixtures");

function assertValidEnvironment(value: string): MigrationEnvironment {
  if ((MIGRATION_ENVIRONMENTS as readonly string[]).includes(value)) {
    return value as MigrationEnvironment;
  }
  console.error(
    `Error: invalid --env "${value}". Must be one of: ${MIGRATION_ENVIRONMENTS.join(", ")}.`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]): {
  env: MigrationEnvironment;
  connectionString: string;
  fixturesDir: string;
  fixtures: string | null;
  report: "json" | "text";
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let fixtures: string | null = null;
  let report: "json" | "text" = "text";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = assertValidEnvironment(args[++i]);
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--fixtures-dir" && args[i + 1]) {
      fixturesDir = args[++i];
    } else if (args[i] === "--fixtures" && args[i + 1]) {
      fixtures = args[++i];
    } else if (args[i] === "--report" && args[i + 1]) {
      const value = args[++i];
      if (value !== "json" && value !== "text") {
        console.error(`Error: --report must be "json" or "text", got "${value}".`);
        process.exit(1);
      }
      report = value;
    }
  }

  return { env, connectionString, fixturesDir, fixtures, report };
}

const { env, connectionString, fixturesDir, fixtures, report } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

if (!fixtures) {
  console.error("Error: --fixtures <case> is required.");
  process.exit(1);
}

const result = await runParityChecks({
  connectionString,
  fixtureCase: fixtures,
  fixturesDir,
  environment: env,
});

if (report === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\nParity report: ${result.fixtureCase} (${result.environment})`);
  console.log(`Status:   ${result.status.toUpperCase()}`);
  console.log(`Failures: ${result.summary.failures}`);
  console.log(`Warnings: ${result.summary.warnings}`);
  if (result.findings.length > 0) {
    console.log("\nFindings:");
    for (const f of result.findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.code} — ${f.targetObject}`);
      console.log(`    ${f.message}`);
      console.log(`    Expected: ${f.expected}`);
      console.log(`    Actual:   ${f.actual}`);
      if (f.suggestedAction) console.log(`    Fix: ${f.suggestedAction}`);
    }
  }
}

if (result.status === "failed") {
  process.exit(1);
}
