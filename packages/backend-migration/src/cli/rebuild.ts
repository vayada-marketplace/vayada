#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rebuild } from "../rebuild.js";
import { type MigrationEnvironment } from "../runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../../migrations");

const ALL_SCHEMAS = ["platform"] as const;

function parseArgs(argv: string[]): {
  env: MigrationEnvironment;
  connectionString: string;
  migrationsDir: string;
  fixtures: string | null;
  schemas: string[];
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let fixtures: string | null = null;
  let schemas: string[] = [...ALL_SCHEMAS];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = args[++i] as MigrationEnvironment;
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--migrations-dir" && args[i + 1]) {
      migrationsDir = args[++i];
    } else if (args[i] === "--fixtures" && args[i + 1]) {
      fixtures = args[++i];
    } else if (args[i] === "--schemas" && args[i + 1]) {
      schemas = args[++i].split(",").map((s) => s.trim());
    }
  }

  return { env, connectionString, migrationsDir, fixtures, schemas };
}

const { env, connectionString, migrationsDir, fixtures, schemas } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

console.log(`Dropping schemas: ${schemas.join(", ")}`);
const result = await rebuild({ connectionString, migrationsDir, environment: env, schemas });

if (result.applied.length > 0) {
  console.log(`Applied:  ${result.applied.join(", ")}`);
}
if (result.applied.length === 0 && !result.failed) {
  console.log("No migrations to apply.");
}
if (fixtures) {
  console.log(`Fixtures: "${fixtures}" — fixture loader not yet implemented (VAY-616).`);
}
if (result.failed) {
  console.error(`Failed at version ${result.failed}. See platform.schema_migrations for details.`);
  process.exit(1);
}
