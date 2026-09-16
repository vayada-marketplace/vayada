import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSnapshotIdentifier, hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import { VAY_1350_ACTIVE_SOURCE_TABLES } from "./productionIdentitySnapshotReader.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";
import {
  readLegacyHistoricalBindingSourceProof as read,
  type LegacyHistoricalBindingSourceRequest,
} from "./legacyHistoricalBindingSourceProof.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const raw = {
  id: id(701),
  hotel_id: id(702),
  channex_property_id: id(703),
  is_active: true,
  secret: "DO_NOT_REPORT",
};
const request: LegacyHistoricalBindingSourceRequest = {
  sourceRunId: `vay1351-${"a".repeat(24)}`,
  sourceEnvironment: "local",
  sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
  sourceEvidenceSha256: "b".repeat(64),
  snapshotIdentifierSha256: hashSnapshotIdentifier("snapshot-pms"),
  source: {
    id: raw.id,
    hotelId: raw.hotel_id,
    externalPropertyId: raw.channex_property_id,
    rowOrdinal: 1,
    rowChecksumSha256: "c".repeat(64),
  },
};
describe("source proof transaction boundary", () => {
  it("rejects invalid requests before reading", async () => {
    const pool = { connect: vi.fn() };
    await expect(read(pool as never, { ...request, sourceEvidenceSha256: "" })).rejects.toThrow(
      "Invalid",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "rolls back failed reads, discarding on cleanup failure=%s",
    async (cleanupFails) => {
      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK" && cleanupFails) throw new Error("cleanup failed");
        return { rows: [{ complete: false }] };
      });
      await expect(
        read({ connect: async () => ({ query, release }) } as never, request),
      ).rejects.toThrow();
      expect(query).toHaveBeenNthCalledWith(1, "ROLLBACK");
      if (!cleanupFails)
        expect(query).toHaveBeenNthCalledWith(2, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledWith(cleanupFails);
    },
  );
});
const url = process.env["VAY2017_BINDING_SOURCE_TEST_DATABASE_URL"];
describe.skipIf(!url)("source proof on parent-migrated disposable PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_binding_source_fixture" ||
      parsed.search
    )
      throw new Error("Only the dedicated loopback fixture database is allowed");
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool?.end();
  });
  async function seed(rows: Record<string, unknown>[] = [raw], fault = "") {
    const expected = structuredClone(request);
    expected.sourceRunId = `vay1351-${randomBytes(12).toString("hex")}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO platform.source_extraction_runs
        (run_id,environment,source_schema_revision,status,finished_at,duration_ms)
        VALUES($1,'local',$2,'completed',now(),0)`,
        [expected.sourceRunId, VAY_1350_INVENTORY_REVISION],
      );
      const hashes: string[] = [];
      for (const [index, row] of rows.entries()) {
        const normalized = (
          await client.query("SELECT $1::jsonb::text AS text", [JSON.stringify(row)])
        ).rows[0].text;
        const hash = fault === "corrupt" ? "f".repeat(64) : sha(normalized);
        hashes.push(hash);
        await client.query(
          `INSERT INTO migration_source_pms.snapshot_rows
          (run_id,snapshot_identifier,source_schema,source_table,row_ordinal,row_checksum_sha256,row_data)
          VALUES($1,$2,'public','channex_connections',$3,$4,$5::jsonb)`,
          [
            expected.sourceRunId,
            fault === "tag" ? "wrong-tag" : "snapshot-pms",
            index + (fault === "ordinal" ? 2 : 1),
            hash,
            normalized,
          ],
        );
      }
      expected.source.rowChecksumSha256 = hashes[0] ?? sha("");
      for (const [database, tables] of Object.entries(VAY_1350_ACTIVE_SOURCE_TABLES)) {
        const aggregate = createHash("sha256");
        const tableRows = [];
        for (const table of tables) {
          const connection = database === "pms" && table === "public.channex_connections";
          const count = connection ? rows.length : 0;
          const checksum = connection ? sha(hashes.map((h) => `${h}\n`).join("")) : sha("");
          aggregate.update(`${table}|${count}|${checksum}\n`);
          const [schema, relation] = table.split(".");
          tableRows.push([expected.sourceRunId, database, schema, relation, count, checksum]);
        }
        await client.query(
          `INSERT INTO platform.source_extraction_sources
          (run_id,source_database,snapshot_identifier,expected_database_name,expected_schema_fingerprint,actual_schema_fingerprint,
           status,row_count,checksum_sha256,source_snapshot_at,finished_at,duration_ms)
          VALUES($1,$2,$3,$2,$4,$4,'completed',$5,$6,now(),now(),0)`,
          [
            expected.sourceRunId,
            database,
            `snapshot-${database}`,
            "a".repeat(32),
            database === "pms" ? rows.length : 0,
            aggregate.digest("hex"),
          ],
        );
        for (const values of tableRows)
          await client.query(
            `INSERT INTO platform.source_extraction_tables
            (run_id,source_database,source_schema,source_table,status,row_count,checksum_sha256,finished_at,duration_ms)
            VALUES($1,$2,$3,$4,'completed',$5,$6,now(),0)`,
            values,
          );
      }
      const ledger = await readSourceLedger(client, expected.sourceRunId);
      const key = (row: (typeof ledger.tables)[number]) =>
        `${row.source_database}\0${row.source_schema}\0${row.source_table}`;
      ledger.tables.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      expected.sourceEvidenceSha256 = hashSourceLedger(ledger);
      await client.query("COMMIT");
      return expected;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  it.each([true, false])(
    "verifies raw source proof, preserving boolean active=%s without activation",
    async (active) => {
      const expected = await seed([{ ...raw, is_active: active }]);
      const before = structuredClone(expected);
      const result = await read(pool, expected);
      expect(result).toEqual({
        sourceRunId: expected.sourceRunId,
        sourceConnections: [{ ...expected.source, active }],
      });
      expect(expected).toEqual(before);
      expect(Object.isFrozen(result.sourceConnections[0])).toBe(true);
      expect(JSON.stringify(result)).not.toContain("DO_NOT_REPORT");
      expect(pool.totalCount).toBe(pool.idleCount);
    },
  );
  it("resets a leaked snapshot before checking a subsequently committed run", async () => {
    const leaked = await pool.connect();
    const release = vi.spyOn(leaked, "release").mockImplementation(() => {});
    try {
      await leaked.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await leaked.query("SELECT count(*) FROM platform.source_extraction_runs");
      const expected = await seed();
      const result = await read({ connect: async () => leaked } as never, expected);
      expect(result.sourceRunId).toBe(expected.sourceRunId);
      expect(release).toHaveBeenCalledWith(false);
    } finally {
      release.mockRestore();
      await leaked.query("ROLLBACK");
      leaked.release();
    }
  });
  it.each(["forced RLS", "inheritance"])("rejects source relations with %s", async (mode) => {
    const expected = await seed();
    try {
      await pool.query(
        mode === "forced RLS"
          ? "ALTER TABLE migration_source_pms.snapshot_rows FORCE ROW LEVEL SECURITY"
          : "CREATE TABLE migration_source_pms.binding_source_test_child () INHERITS (migration_source_pms.snapshot_rows)",
      );
      await expect(read(pool, expected)).rejects.toThrow("visibility");
    } finally {
      await pool.query(
        mode === "forced RLS"
          ? "ALTER TABLE migration_source_pms.snapshot_rows NO FORCE ROW LEVEL SECURITY"
          : "DROP TABLE IF EXISTS migration_source_pms.binding_source_test_child",
      );
    }
  });
  it("cannot validate against uncommitted evidence on a leaked write transaction", async () => {
    const expected = await seed(),
      leaked = await pool.connect();
    const release = vi.spyOn(leaked, "release").mockImplementation(() => {});
    try {
      await leaked.query("BEGIN");
      await leaked.query(
        "UPDATE platform.source_extraction_runs SET environment='staging' WHERE run_id=$1",
        [expected.sourceRunId],
      );
      const ledger = await readSourceLedger(leaked, expected.sourceRunId);
      const key = (r: (typeof ledger.tables)[number]) =>
        `${r.source_database}\0${r.source_schema}\0${r.source_table}`;
      ledger.tables.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      expected.sourceEnvironment = "staging";
      expected.sourceEvidenceSha256 = hashSourceLedger(ledger);
      await expect(read({ connect: async () => leaked } as never, expected)).rejects.toThrow(
        "ledger mismatch",
      );
      expect(
        (
          await leaked.query(
            "SELECT environment FROM platform.source_extraction_runs WHERE run_id=$1",
            [expected.sourceRunId],
          )
        ).rows[0].environment,
      ).toBe("local");
    } finally {
      release.mockRestore();
      await leaked.query("ROLLBACK");
      leaked.release();
    }
  });
  it("ignores persisted temporary catalogs that hide source inheritance", async () => {
    const expected = await seed();
    const client = await pool.connect();
    const release = vi.spyOn(client, "release").mockImplementation(() => {});
    try {
      await client.query(
        "CREATE TEMP TABLE pg_inherits (inhrelid oid, inhparent oid); CREATE TABLE migration_source_pms.binding_source_test_child () INHERITS (migration_source_pms.snapshot_rows)",
      );
      await expect(read({ connect: async () => client } as never, expected)).rejects.toThrow(
        "visibility",
      );
    } finally {
      release.mockRestore();
      await client.query(
        "ROLLBACK; DROP TABLE IF EXISTS pg_temp.pg_inherits; DROP TABLE IF EXISTS migration_source_pms.binding_source_test_child",
      );
      client.release();
    }
  });
  it.each(["duplicate", "hotel", "external", "missing", "id", "boolean"])(
    "rejects %s source rows",
    async (mode) => {
      const second = { ...raw, id: id(704) };
      const rows =
        mode === "missing"
          ? []
          : mode === "id"
            ? [second]
            : mode === "boolean"
              ? [{ ...raw, is_active: "true" }]
              : [
                  raw,
                  {
                    ...second,
                    ...(mode === "hotel"
                      ? { channex_property_id: id(705) }
                      : mode === "external"
                        ? { hotel_id: id(706) }
                        : {}),
                  },
                ];
      await expect(read(pool, await seed(rows))).rejects.toThrow("source rows mismatch");
    },
  );
  it.each(["corrupt", "ordinal", "tag"])(
    "recomputes and rejects %s immutable rows",
    async (fault) => {
      await expect(read(pool, await seed([raw], fault))).rejects.toThrow(
        "corrupt pms.channex_connections",
      );
    },
  );
  it.each(["id", "hotelId", "externalPropertyId", "rowOrdinal", "rowChecksumSha256"] as const)(
    "binds exact source %s",
    async (field) => {
      const expected = await seed();
      Object.assign(expected.source, {
        [field]:
          field === "rowOrdinal" ? 2 : field === "rowChecksumSha256" ? "f".repeat(64) : id(707),
      });
      await expect(read(pool, expected)).rejects.toThrow("source rows mismatch");
    },
  );
  it.each([
    "sourceEvidenceSha256",
    "snapshotIdentifierSha256",
    "sourceEnvironment",
    "sourceSchemaRevision",
  ] as const)("binds expected %s", async (field) => {
    const expected = await seed();
    Object.assign(expected, {
      [field]:
        field === "sourceEnvironment"
          ? "staging"
          : "f".repeat(field === "sourceSchemaRevision" ? 40 : 64),
    });
    await expect(read(pool, expected)).rejects.toThrow("ledger mismatch");
  });
});
