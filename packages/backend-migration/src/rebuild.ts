import pg from "pg";

import { type RunnerConfig, type RunResult, runMigrations } from "./runner.js";

export type RebuildConfig = RunnerConfig & {
  schemas: string[];
};

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe schema identifier: "${name}"`);
  }
}

export async function rebuild(config: RebuildConfig): Promise<RunResult> {
  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    for (const schema of config.schemas) {
      assertSafeIdentifier(schema);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client.end();
  }

  return runMigrations(config);
}
