import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

export type TargetDatabase = Record<string, never>;

export type DatabaseConfig = {
  connectionString: string;
  max?: number;
};

export function createDatabase(config: DatabaseConfig): Kysely<TargetDatabase> {
  return new Kysely<TargetDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: config.connectionString,
        max: config.max,
      }),
    }),
  });
}
