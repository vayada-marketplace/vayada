import { MIGRATION_ENVIRONMENTS, type MigrationEnvironment } from "../runner.js";

export function assertValidEnvironment(value: string): MigrationEnvironment {
  if ((MIGRATION_ENVIRONMENTS as readonly string[]).includes(value)) {
    return value as MigrationEnvironment;
  }
  console.error(
    `Error: invalid --env "${value}". Must be one of: ${MIGRATION_ENVIRONMENTS.join(", ")}.`,
  );
  process.exit(1);
}
