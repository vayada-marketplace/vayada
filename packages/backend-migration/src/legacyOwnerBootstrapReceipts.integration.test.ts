import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

const url = process.env["VAY2017_RECEIPT_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const insert = `INSERT INTO platform.legacy_owner_bootstrap_receipts
 (command_id,contract_version,environment,payload_sha256,owner_user_ids,
 source_run_id,source_evidence_sha256,target_before_sha256,target_after_sha256,
 approval_envelope_sha256,executor_principal_sha256,checkpoint)
 VALUES ($1,'legacy-owner-internal-setup.v1','local',$2,$3,
 'vay1351-aaaaaaaaaaaaaaaaaaaaaaaa',$2,$2,$2,$2,$2,'internal_users_prepared')`;
describe.skipIf(!url)("immutable internal owner setup receipts", () => {
  let client: pg.Client;
  let sequence = 100;
  const write = (owners: (string | null)[] = [id(1)], hash = "a".repeat(64)) =>
    client.query(insert, [id(sequence++), hash, owners]);
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_receipt_fixture" ||
      parsed.search
    )
      throw new Error("Dedicated loopback receipt fixture required");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0194");
  }, 120_000);
  afterAll(async () => {
    await client?.end();
  });

  it("stores a sorted eight-owner subset without creating users", async () => {
    await write(Array.from({ length: 8 }, (_, n) => id(n + 1)));
    expect((await client.query("SELECT count(*)::int AS n FROM identity.users")).rows[0].n).toBe(0);
  });
  it.each([
    [],
    [id(1), id(1)],
    [id(2), id(1)],
    [null],
    Array.from({ length: 9 }, (_, n) => id(n + 1)),
  ])("rejects invalid cohort %j", async (...owners) => {
    await expect(write(owners as (string | null)[])).rejects.toThrow();
  });
  it("rejects malformed hashes", async () => {
    await expect(write([id(1)], "invalid")).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects nonstandard bounds and invalid operation metadata", async () => {
    await expect(
      client.query(insert, [id(sequence++), "a".repeat(64), `[0:0]={${id(1)}}`]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const [from, to] of [
      ["'internal_users_prepared'", "'provider_ready'"],
      ["'local'", "'unknown'"],
      ["'legacy-owner-internal-setup.v1'", "'v2'"],
    ])
      await expect(
        client.query(insert.replace(from!, to!), [id(sequence++), "a".repeat(64), [id(1)]]),
      ).rejects.toMatchObject({ code: "23514" });
  });
  it("receipt insertion failure rolls back a pending user", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO identity.users(id,email,status) VALUES($1,'rejected-receipt@example.invalid','pending')",
        [id(10)],
      );
      await expect(write([id(10)], "invalid")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
    }
    expect(
      (await client.query("SELECT 1 FROM identity.users WHERE id=$1", [id(10)])).rowCount,
    ).toBe(0);
  });
  it("rejects null and multidimensional arrays", async () => {
    await expect(
      client.query(insert, [id(sequence++), "a".repeat(64), null]),
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      client.query(insert, [id(sequence++), "a".repeat(64), [[id(1)], [id(2)]]]),
    ).rejects.toThrow();
  });
  it("cannot update, delete or truncate historical receipts", async () => {
    await write();
    for (const sql of [
      "UPDATE platform.legacy_owner_bootstrap_receipts SET payload_sha256=repeat('b',64)",
      "DELETE FROM platform.legacy_owner_bootstrap_receipts",
      "TRUNCATE platform.legacy_owner_bootstrap_receipts",
    ])
      await expect(client.query(sql)).rejects.toThrow();
  });
  it("rolls back user and receipt together on a later failure", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO identity.users(id,email,status) VALUES($1,'receipt@example.invalid','pending')",
        [id(9)],
      );
      await write([id(9)]);
      await expect(client.query("SELECT 1/0")).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
    }
    expect((await client.query("SELECT 1 FROM identity.users WHERE id=$1", [id(9)])).rowCount).toBe(
      0,
    );
    expect(
      (
        await client.query(
          "SELECT 1 FROM platform.legacy_owner_bootstrap_receipts WHERE owner_user_ids=ARRAY[$1::uuid]",
          [id(9)],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("primary key arbitrates concurrent duplicate commands", async () => {
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      const command = id(sequence++);
      const results = await Promise.allSettled([
        client.query(insert, [command, "a".repeat(64), [id(1)]]),
        other.query(insert, [command, "b".repeat(64), [id(2)]]),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason.code).toBe("23505");
    } finally {
      await other.end();
    }
  });
  it("has no PUBLIC read or insert access", async () => {
    const result = await client.query(`SELECT count(*)::int AS n FROM pg_class c,
      aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='platform.legacy_owner_bootstrap_receipts'::regclass AND a.grantee=0`);
    expect(result.rows[0].n).toBe(0);
  });
});
