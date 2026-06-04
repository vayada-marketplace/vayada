#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATION_ENVIRONMENTS, runMigrations, type MigrationEnvironment } from "../runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../../migrations");

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
  migrationsDir: string;
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = assertValidEnvironment(args[++i]);
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--migrations-dir" && args[i + 1]) {
      migrationsDir = args[++i];
    }
  }

  return { env, connectionString, migrationsDir };
}

const { env, connectionString, migrationsDir } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

const result = await runMigrations({ connectionString, migrationsDir, environment: env });

if (result.applied.length > 0) {
  console.log(`Applied:  ${result.applied.join(", ")}`);
}
if (result.skipped.length > 0) {
  console.log(`Skipped:  ${result.skipped.join(", ")}`);
}
if (result.applied.length === 0 && result.skipped.length === 0 && !result.failed) {
  console.log("No migrations to apply.");
}
if (result.failed) {
  console.error(`Failed at version ${result.failed}. See platform.schema_migrations for details.`);
  process.exit(1);
}
