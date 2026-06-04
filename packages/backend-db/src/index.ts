import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

export type TargetDatabase = Record<string, never>;

export type DatabaseConfig = {
  connectionString: string;
  max?: number;
};

/** Creates a Kysely client for the target database after validating pool config. */
export function createDatabase(config: DatabaseConfig): Kysely<TargetDatabase> {
  if (config.connectionString.trim() === "") {
    throw new Error("Invalid DatabaseConfig.connectionString");
  }

  if (config.max !== undefined && (!Number.isInteger(config.max) || config.max <= 0)) {
    throw new Error("Invalid DatabaseConfig.max");
  }

  return new Kysely<TargetDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: config.connectionString,
        max: config.max,
      }),
    }),
  });
}
