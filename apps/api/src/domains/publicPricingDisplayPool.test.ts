import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { displayStatement, lockFreePool } from "./publicPricingDisplayPool.js";

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

  it("refuses any other advisory lock and a read-write transaction", () => {
    for (const sql of [
      "SELECT pg_advisory_xact_lock(1), now()",
      "SELECT pg_try_advisory_lock(1)",
      "SELECT x FROM t WHERE pg_advisory_xact_lock_shared(1) IS NOT NULL",
      "SELECT pg_advisory_unlock(1)",
      "BEGIN READ WRITE",
      "SET TRANSACTION READ WRITE",
    ])
      expect(() => displayStatement(sql)).toThrow();
  });

  it("runs clients' and the pool's queries rewritten, and refuses callbacks", async () => {
    const clientQuery = vi.fn(async () => ({ rows: [{ ok: true }] }));
    const release = vi.fn();
    const client = { query: clientQuery, release } as unknown as PoolClient;
    const poolQuery = vi.fn(async () => ({ rows: [] }));
    const pool = lockFreePool({
      connect: async () => client,
      query: poolQuery,
      totalCount: 3,
    } as unknown as Pool);
    const wrapped = await pool.connect();
    await wrapped.query("SELECT 1 FROM t WHERE id=$1 FOR SHARE", [7]);
    expect(clientQuery).toHaveBeenLastCalledWith({
      text: "SELECT 1 FROM t WHERE id=$1 ",
      values: [7],
    });
    await wrapped.query({ text: "SELECT 2 FROM t FOR UPDATE", values: [] });
    expect(clientQuery).toHaveBeenLastCalledWith({ text: "SELECT 2 FROM t ", values: [] });
    expect(await wrapped.query("SELECT pg_advisory_xact_lock(1)")).toMatchObject({ rowCount: 1 });
    expect(clientQuery).toHaveBeenCalledTimes(2);
    await expect(wrapped.query("SELECT pg_try_advisory_xact_lock(1)")).rejects.toThrow();
    await expect(
      (wrapped.query as unknown as (...args: unknown[]) => Promise<unknown>)(
        "SELECT 1",
        [],
        () => undefined,
      ),
    ).rejects.toThrow();
    wrapped.release();
    expect(release).toHaveBeenCalledOnce();
    await pool.query("SELECT 3 FROM t FOR KEY SHARE");
    expect(poolQuery).toHaveBeenLastCalledWith({ text: "SELECT 3 FROM t " });
    expect(pool.totalCount).toBe(3);
  });
});
