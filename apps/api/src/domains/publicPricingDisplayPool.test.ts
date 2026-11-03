import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installPostgresPoolRuntime } from "../platform/postgresRuntime.js";
import {
  checkouts,
  displayPoolConfig,
  displayStatement,
  lockFreePool,
} from "./publicPricingDisplayPool.js";

describe("display prices statements (VAY-2458)", () => {
  it("drops every row-lock clause and keeps the rest of the statement", () => {
    expect(displayStatement("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE")).toBe(
      "SELECT id FROM identity.organizations WHERE id=$1 ",
    );
    expect(
      displayStatement(`SELECT 1 FROM a s JOIN b p ON true
    FOR SHARE OF s,p,location,profile`),
    ).toBe("SELECT 1 FROM a s JOIN b p ON true\n    ");
    expect(displayStatement("SELECT 1 FROM t FOR NO KEY UPDATE OF t NOWAIT")).toBe(
      "SELECT 1 FROM t ",
    );
    expect(displayStatement("SELECT 1 FROM t FOR KEY SHARE SKIP LOCKED")).toBe("SELECT 1 FROM t ");
    expect(
      displayStatement("SELECT (SELECT 1 FROM a FOR SHARE NOWAIT), b FROM c FOR UPDATE OF c"),
    ).toBe("SELECT (SELECT 1 FROM a ), b FROM c ");
    // Written in lower case too.
    expect(displayStatement("select 1 from t for share of t")).toBe("select 1 from t ");
    // Not a lock clause.
    expect(displayStatement("INSERT INTO t VALUES (1) ON CONFLICT DO UPDATE SET x=1")).toBe(
      "INSERT INTO t VALUES (1) ON CONFLICT DO UPDATE SET x=1",
    );
  });

  it("skips statements that only take a transaction advisory lock", () => {
    for (const sql of [
      "SELECT pg_advisory_xact_lock(hashtextextended(concat('pms-inventory:', $1::uuid::text), 0))",
      `SELECT pg_advisory_xact_lock(
       hashtext('booking.publication'),
       hashtext($1::uuid::text)
     )`,
      "SELECT pg_advisory_xact_lock(hashtext('it''s (odd)'), 1);",
    ])
      expect(displayStatement(sql)).toBeNull();
  });

  it("refuses any other advisory lock and any change to read-only mode", () => {
    for (const sql of [
      "SELECT pg_advisory_xact_lock(1), now()",
      "SELECT pg_try_advisory_lock(1)",
      "SELECT x FROM t WHERE pg_advisory_xact_lock_shared(1) IS NOT NULL",
      "SELECT pg_advisory_unlock(1)",
      "SET TRANSACTION READ WRITE",
      "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
      "SET transaction_read_only = off",
      "SET LOCAL default_transaction_read_only TO off",
    ])
      expect(() => displayStatement(sql)).toThrow();
  });
});

describe("display prices pool (VAY-2458)", () => {
  const fake = () => {
    const clientQuery = vi.fn(async (query: unknown) =>
      typeof query === "string" && query.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ")
        ? [{ command: "BEGIN" }, { command: "SET" }, { command: "SET" }]
        : { rows: [{ ok: true }] },
    );
    const release = vi.fn();
    const client = { query: clientQuery, release } as unknown as PoolClient;
    const pool = lockFreePool({ connect: async () => client, totalCount: 3 } as unknown as Pool);
    return { clientQuery, release, pool };
  };

  it("runs each transaction read-only in one snapshot, with timeouts, and rewrites its statements", async () => {
    const { clientQuery, release, pool } = fake();
    const client = await pool.connect();
    // Whatever the caller begins.
    expect(await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")).toEqual({
      command: "BEGIN",
    });
    expect(clientQuery).toHaveBeenLastCalledWith(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '3s'",
    );
    await client.query("SELECT 1 FROM t WHERE id=$1 FOR SHARE", [7]);
    expect(clientQuery).toHaveBeenLastCalledWith({
      text: "SELECT 1 FROM t WHERE id=$1 ",
      values: [7],
    });
    await client.query({ text: "SELECT 2 FROM t FOR UPDATE", values: [] });
    expect(clientQuery).toHaveBeenLastCalledWith({ text: "SELECT 2 FROM t ", values: [] });
    expect(await client.query("SELECT pg_advisory_xact_lock(1)")).toMatchObject({ rowCount: 1 });
    expect(clientQuery).toHaveBeenCalledTimes(3);
    await expect(client.query("SELECT pg_try_advisory_xact_lock(1)")).rejects.toThrow();
    await expect(client.query("BEGIN")).rejects.toThrow("one transaction at a time");
    await expect(
      (client.query as unknown as (...args: unknown[]) => Promise<unknown>)(
        "SELECT 1",
        [],
        () => undefined,
      ),
    ).rejects.toThrow();
    await client.query("ROLLBACK");
    expect(clientQuery).toHaveBeenLastCalledWith({ text: "ROLLBACK" });
    // Nothing runs outside a transaction it began.
    await expect(client.query("SELECT 3")).rejects.toThrow("inside a read-only transaction");
    await expect(client.query("BEGIN READ WRITE")).rejects.toThrow("read-only mode");
    client.release();
    expect(release).toHaveBeenCalledOnce();
    // Nor on the pool itself.
    await expect(pool.query("SELECT 3 FROM t")).rejects.toThrow("use connect()");
    expect(pool.totalCount).toBe(3);
  });

  it("checks out at most its size at once; the rest wait here, in turn and for a while", async () => {
    const released = vi.fn();
    const pool = lockFreePool(
      {
        connect: async () => ({ query: vi.fn(), release: released }) as unknown as PoolClient,
      } as unknown as Pool,
      checkouts(1, 50),
    );
    const first = await pool.connect();
    let second: PoolClient | null = null;
    const waiting = pool.connect().then((client) => (second = client));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBeNull();
    first.release();
    first.release(); // Once only.
    await waiting;
    expect(second).not.toBeNull();
    expect(released).toHaveBeenCalledOnce();
    // Nobody releases: the next one gives up.
    await expect(pool.connect()).rejects.toThrow("waited too long");
    second!.release();
    (await pool.connect()).release();
    expect(released).toHaveBeenCalledTimes(3);
    // A failed connection gives its place back.
    const failing = lockFreePool(
      {
        connect: async () => {
          throw new Error("refused");
        },
      } as unknown as Pool,
      checkouts(1, 50),
    );
    await expect(failing.connect()).rejects.toThrow("refused");
    await expect(failing.connect()).rejects.toThrow("refused");
  });

  it("is a pool of its own with the runtime's connections under production's pool runtime", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const connectionString = "postgresql://example/target";
    const general = new postgres.Pool({ connectionString, connectionTimeoutMillis: 3000 });
    const display = new postgres.Pool(displayPoolConfig({ connectionString, max: 4 }));
    try {
      // Not a one-connection "tuned" pool, and not sharing the API's general pool.
      expect(display.options.max).toBe(8);
      expect(runtime.snapshot().physicalPoolCount).toBe(2);
    } finally {
      await general.end();
      await display.end();
      await runtime.close();
    }
  });
});
