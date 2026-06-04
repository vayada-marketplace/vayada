import pg from "pg";

import {
  ADVISORY_LOCK_ID,
  acquireAdvisoryLock,
  applyMigrations,
  type RunnerConfig,
  type RunResult,
} from "./runner.js";

export type RebuildConfig = RunnerConfig & {
  schemas: string[];
};

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe schema identifier: "${name}"`);
  }
}

export async function rebuild(config: RebuildConfig): Promise<RunResult> {
  if (config.environment !== "local") {
    throw new Error(
      `rebuild is only supported in the local environment (got "${config.environment}"). ` +
        `Use target:migrate for non-local environments.`,
    );
  }

  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    // Hold the advisory lock across both the DROP SCHEMA and migration phases so
    // concurrent rebuild/migrate calls cannot interleave.
    await acquireAdvisoryLock(client);

    for (const schema of config.schemas) {
      assertSafeIdentifier(schema);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }

    return await applyMigrations(config, client);
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch {
      // best-effort; connection close releases it anyway
    }
    await client.end();
  }
}
