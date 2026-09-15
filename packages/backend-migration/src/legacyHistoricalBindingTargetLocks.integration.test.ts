import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";
import { lockLegacyHistoricalBindingTarget as lock } from "./legacyHistoricalBindingTargetLocks.js";

const url = process.env["VAY2017_TARGET_LOCK_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run = `vay1351-${"a".repeat(24)}`;
describe.skipIf(!url)("historical prepare target locks on disposable PostgreSQL", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let other: pg.PoolClient;
  let expected: Parameters<typeof lock>[1];
  const begin = (db = client) =>
    db.query("BEGIN; SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='3s'");
  const insertConnection = (db: pg.PoolClient, n = 12) =>
    db.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,connection_metadata)
    VALUES($1,$2,'channex','disconnected',$3::jsonb)`,
      [
        id(n),
        id(n === 12 ? 2 : 1),
        JSON.stringify({ legacyExternalPropertyId: id(9), migrationRunId: run }),
      ],
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56636", "56637"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_target_lock_fixture" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated loopback historical target fixture required");
    pool = new pg.Pool({ connectionString: url });
    client = await pool.connect();
    other = await pool.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    await client.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
      VALUES($1,'lock-one','Synthetic'),($2,'lock-two','Synthetic')`,
      [id(1), id(2)],
    );
    await client.query(
      `INSERT INTO pms.channel_binding_claims
      (id,property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1,$2,'channex',$3,'historical','migration')`,
      [id(10), id(1), id(9)],
    );
    await insertConnection(client, 11);
    const snapshot = await readLegacyHistoricalBindingTargetSnapshot(pool, {
      propertyId: id(1),
      externalPropertyId: id(9),
    });
    expected = {
      sourceActive: true,
      binding: {
        property: snapshot.property,
        bindingExpected: {
          sourceRunId: run,
          source: {
            id: id(20),
            hotelId: id(1),
            externalPropertyId: id(9),
            rowOrdinal: 1,
            rowChecksumSha256: "a".repeat(64),
          },
          propertyId: id(1),
          claim: snapshot.claims[0]!,
          connections: snapshot.connections,
        },
      },
    };
  }, 120000);
  beforeEach(() => begin());
  afterEach(async () => {
    await other.query("ROLLBACK");
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    client?.release();
    other?.release();
    await pool?.end();
  });
  it("retains exact target locks without changing history or live connection", async () => {
    expect(await lock(client, expected)).toEqual({
      outcome: "target_locked_requires_owner_and_source",
      executable: false,
    });
    expect((await client.query("SELECT claim_state FROM pms.channel_binding_claims")).rows).toEqual(
      [{ claim_state: "historical" }],
    );
    expect(
      (
        await client.query(
          "SELECT connection_status,external_property_id FROM pms.channel_connections",
        )
      ).rows,
    ).toEqual([{ connection_status: "disconnected", external_property_id: null }]);
    expect(
      (await client.query("SELECT 1 FROM platform.legacy_historical_binding_transitions")).rowCount,
    ).toBe(0);
  });
  it.each(["property", "claim", "metadata", "phantom"])(
    "fences concurrent %s writes",
    async (kind) => {
      await lock(client, expected);
      await begin(other);
      const write =
        kind === "phantom"
          ? insertConnection(other)
          : other.query(
              {
                property: "UPDATE hotel_catalog.properties SET display_name='changed' WHERE id=$1",
                claim:
                  "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
                metadata:
                  "UPDATE pms.channel_connections SET connection_metadata='{}'::jsonb WHERE property_id=$1",
              }[kind as "property" | "claim" | "metadata"],
              [id(1)],
            );
      await expect(write).rejects.toMatchObject({ code: "55P03" });
    },
  );
  it.each(["management", "external-property"])(
    "uses existing %s advisory namespace",
    async (kind) => {
      await begin(other);
      await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `channex.${kind}:${id(kind === "management" ? 1 : 9)}`,
      ]);
      await expect(lock(client, expected)).rejects.toThrow();
      await insertConnection(other);
      expect(
        (
          await other.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            [`channex.external-property:${id(9)}`],
          )
        ).rows[0]?.acquired,
      ).toBe(true);
      expect((await client.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
    },
  );
  it("releases earlier property locks when a later claim lock fails", async () => {
    await begin(other);
    await other.query("SELECT 1 FROM pms.channel_binding_claims WHERE id=$1 FOR UPDATE", [id(10)]);
    await expect(lock(client, expected)).rejects.toThrow();
    await other.query(
      "UPDATE hotel_catalog.properties SET display_name='rollback-control' WHERE id=$1",
      [id(1)],
    );
    await insertConnection(other);
  });
  it.each(["hotel_catalog.properties", "pms.channel_binding_claims", "pms.channel_connections"])(
    "rejects RLS-enabled %s even for bypass role",
    async (table) => {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await expect(lock(client, expected)).rejects.toThrow();
    },
  );
  it("rejects an in-flight connection writer immediately and releases partial locks", async () => {
    await begin(other);
    await insertConnection(other);
    await expect(lock(client, expected)).rejects.toThrow();
    expect((await client.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
    const acquired = await other.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [`channex.management:${id(1)}`],
    );
    expect(acquired.rows[0]?.acquired).toBe(true);
  });
  it.each(["property", "claim", "connection", "extra", "cross-pair"])(
    "rejects stale or competing %s target",
    async (kind) => {
      if (kind === "property")
        await client.query("UPDATE hotel_catalog.properties SET display_name='newer' WHERE id=$1", [
          id(1),
        ]);
      if (kind === "claim")
        await client.query(
          "UPDATE pms.channel_binding_claims SET claim_state='verified_non_active' WHERE id=$1",
          [id(10)],
        );
      if (kind === "connection")
        await client.query(
          "UPDATE pms.channel_connections SET connection_metadata='{}' WHERE id=$1",
          [id(11)],
        );
      if (kind === "extra") await insertConnection(client);
      if (kind === "cross-pair")
        await client.query(
          "UPDATE pms.channel_binding_claims SET external_property_id=$1 WHERE id=$2",
          [id(8), id(10)],
        );
      await expect(lock(client, expected)).rejects.toThrow();
    },
  );
  it.each([false, null])("keeps source activity %s held", async (sourceActive) => {
    await expect(
      lock(client, { ...expected, sourceActive: sourceActive as boolean }),
    ).rejects.toThrow();
  });
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("excludes protected key %s", async (key) => {
    const changed = structuredClone(expected);
    changed.binding.bindingExpected.source.externalPropertyId = key;
    await expect(lock(client, changed)).rejects.toThrow();
  });
  it("releases retained locks on outer rollback", async () => {
    await lock(client, expected);
    await client.query("ROLLBACK");
    await begin(other);
    await insertConnection(other);
  });
  it("refuses unbounded or missing transactions", async () => {
    await client.query("SET LOCAL lock_timeout='0'");
    await expect(lock(client, expected)).rejects.toThrow();
    await client.query("ROLLBACK");
    await expect(lock(client, expected)).rejects.toThrow();
  });
});
