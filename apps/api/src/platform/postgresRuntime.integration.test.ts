import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { installPostgresPoolRuntime, isPostgresUnavailableError } from "./postgresRuntime.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

function assertTestDatabase(): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(TEST_DATABASE_URL!).pathname)) {
    throw new Error("Refusing to run PostgreSQL pool integration outside a test database");
  }
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL runtime pool budget", () => {
  it("serves concurrent logical pools through one bounded physical pool", async () => {
    assertTestDatabase();
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const pools = Array.from(
      { length: 24 },
      () => new postgres.Pool({ connectionString: TEST_DATABASE_URL!, max: 10 }),
    );

    try {
      await Promise.all(pools.map((pool) => pool.query("SELECT pg_sleep(0.05)")));
      expect(runtime.snapshot()).toMatchObject({
        physicalPoolCount: 1,
        maxConnections: 8,
        totalConnections: 8,
        idleConnections: 8,
        waitingRequests: 0,
      });
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await runtime.close();
    }
  });

  it("recovers in place after PostgreSQL terminates every runtime connection", async () => {
    assertTestDatabase();
    // A unique application_name keeps the termination away from other suites' sessions.
    const applicationName = `vay2084_${randomUUID().slice(0, 8)}`;
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set("application_name", applicationName);
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const pool = new postgres.Pool({ connectionString: url.toString() });
    const health = runtime.healthCheck(url.toString());
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    // Released in finally if an assertion fails first, so pool.end() can't wait forever.
    let held: pg.PoolClient | undefined;
    let transaction: pg.PoolClient | undefined;
    try {
      await Promise.all(Array.from({ length: 4 }, () => pool.query("SELECT pg_sleep(0.05)")));
      held = await pool.connect();
      transaction = await pool.connect();
      await transaction.query("BEGIN");
      await transaction.query("SELECT 1");
      expect(await health()).toBe(true);
      const inFlight = pool.query("SELECT pg_sleep(30)").then(
        () => undefined,
        (error: unknown) => error,
      );
      await eventually(async () => {
        const { rows } = await admin.query<{ running: number }>(
          `SELECT count(*)::int AS running FROM pg_stat_activity
            WHERE application_name = $1 AND query = 'SELECT pg_sleep(30)'`,
          [applicationName],
        );
        return rows[0]?.running === 1;
      });

      // One pooled client stays idle, so the idle path (pg-pool re-emitting on the pool) runs too.
      expect(pool.idleCount).toBeGreaterThan(0);
      const { rows } = await admin.query<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
          WHERE application_name = $1`,
        [applicationName],
      );
      // Idle pool clients, the held and in-transaction clients, the in-flight query and the probe.
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.every(({ terminated }) => terminated)).toBe(true);

      // No test-side listeners on the clients: only the runtime's own keep this process alive.
      expect(isPostgresUnavailableError(await inFlight)).toBe(true);
      const failed = (client: pg.PoolClient, sql: string) =>
        client.query(sql).then(
          () => false,
          (error: unknown) => isPostgresUnavailableError(error),
        );
      await eventually(() => failed(held!, "SELECT 1"));
      await eventually(() => failed(transaction!, "COMMIT"));
      held.release();
      transaction.release();
      held = transaction = undefined;

      // The same pools serve again once their broken clients are replaced: no restart.
      await eventually(async () => (await pool.query("SELECT 1 AS ok")).rows[0]?.ok === 1);
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      expect(await health()).toBe(true);
    } finally {
      held?.release();
      transaction?.release();
      await admin.end();
      await pool.end();
      await runtime.close();
    }
  }, 30_000);
});
