import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashExpectedDatabaseName,
  hashSnapshotIdentifier,
  hashSourceLedger,
  type SourceLedger,
} from "./channexAdoptionManifestCrypto.js";
import {
  readLegacyOwnerBootstrapSources,
  type OwnerSourceRequest,
} from "./legacyOwnerBootstrapSourceReader.js";
import { VAY_1350_ACTIVE_SOURCE_TABLES } from "./productionIdentitySnapshotReader.js";
import { runMigrations } from "./runner.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";

const url = process.env["VAY2017_SOURCE_READER_TEST_DATABASE_URL"];
const runId = `vay1351-${"a".repeat(24)}`;
const at = "2026-09-14T00:00:00.000000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!url)("bounded owner source reader on migrated PostgreSQL", () => {
  let client: pg.Client;
  let request: OwnerSourceRequest;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_source_reader_fixture" ||
      parsed.search
    )
      throw Error("Dedicated loopback fixture only");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='platform'")).rowCount,
    ).toBe(0);
    expect(
      (
        await runMigrations({
          connectionString: url!,
          migrationsDir: join(import.meta.dirname, "../migrations"),
          environment: "local",
        })
      ).failed,
    ).toBeNull();
    request = await seed(client);
  }, 120000);

  afterAll(async () => client?.end());

  it("reads the exact sixteen historical rows in one read-only snapshot", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const result = await readLegacyOwnerBootstrapSources(client, request);
      expect(result).toHaveLength(8);
      expect(result.every((row) => row.sourceOwnership === "matched")).toBe(true);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("rejects safe-looking session defaults without an active transaction", async () => {
    await client.query("SET default_transaction_read_only=on");
    await client.query("SET default_transaction_isolation='repeatable read'");
    try {
      await expect(readLegacyOwnerBootstrapSources(client, request)).rejects.toThrow(
        "OWNER_SOURCE_READ_FAILED",
      );
    } finally {
      await client.query("SET default_transaction_read_only=off");
      await client.query("SET default_transaction_isolation='read committed'");
    }
  });

  it("keeps concurrent commits outside the caller-owned snapshot", async () => {
    const peer = new pg.Client({ connectionString: url });
    await peer.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let queries = 0;
    const wrapped = {
      query: async (...args: Parameters<pg.Client["query"]>) => {
        const result = await (client.query as (...inner: typeof args) => Promise<unknown>)(...args);
        if (++queries === 1)
          await peer.query(
            `UPDATE migration_source_auth.snapshot_rows
             SET row_data=jsonb_set(row_data,'{status}','"suspended"')
             WHERE run_id=$1 AND source_table='users' AND row_ordinal=1`,
            [runId],
          );
        return result;
      },
    };
    try {
      const result = await readLegacyOwnerBootstrapSources(wrapped as never, request);
      expect(result[0]!.sourceStatus).toBe("pending");
    } finally {
      await client.query("ROLLBACK");
      await peer.end();
    }
  });
});

async function seed(client: pg.Client): Promise<OwnerSourceRequest> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id,environment,source_schema_revision,status,started_at,finished_at,duration_ms)
     VALUES($1,'preprod',$2,'completed',$3,$3,0)`,
    [runId, VAY_1350_INVENTORY_REVISION, at],
  );
  const owners: OwnerSourceRequest["owners"] = [];
  for (let index = 1; index <= 8; index++) {
    const ownerId = id(index),
      hotelId = id(index + 20);
    const user = (
      await client.query<{ checksum: string }>(
        `INSERT INTO migration_source_auth.snapshot_rows
           (run_id,snapshot_identifier,source_schema,source_table,row_ordinal,row_checksum_sha256,row_data)
         VALUES($1,'snapshot-auth','public','users',$2,
           encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$3::jsonb)
         RETURNING row_checksum_sha256 AS checksum`,
        [
          runId,
          index,
          JSON.stringify({
            id: ownerId,
            email: `owner${index}@example.invalid`,
            status: "pending",
            type: "hotel",
          }),
        ],
      )
    ).rows[0]!.checksum;
    const hotel = (
      await client.query<{ checksum: string }>(
        `INSERT INTO migration_source_pms.snapshot_rows
           (run_id,snapshot_identifier,source_schema,source_table,row_ordinal,row_checksum_sha256,row_data)
         VALUES($1,'snapshot-pms','public','hotels',$2,
           encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),$3::jsonb)
         RETURNING row_checksum_sha256 AS checksum`,
        [runId, index, JSON.stringify({ id: hotelId, user_id: ownerId })],
      )
    ).rows[0]!.checksum;
    owners.push({
      ownerId,
      hotelId,
      userOrdinal: index,
      hotelOrdinal: index,
      userSha256: user,
      hotelSha256: hotel,
    });
  }
  const ledger = await seedLedger(client);
  return {
    sourceRunId: runId,
    sourceEnvironment: "preprod",
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    ledgerSha256: hashSourceLedger(ledger),
    owners,
  };
}

async function seedLedger(client: pg.Client): Promise<SourceLedger> {
  const tables: SourceLedger["tables"] = [],
    sources: SourceLedger["sources"] = [];
  for (const database of ["auth", "booking", "marketplace", "pms"] as const) {
    let count = 0;
    const sourceHash = createHash("sha256");
    for (const qualified of VAY_1350_ACTIVE_SOURCE_TABLES[database]) {
      const [schema, table] = qualified.split(".") as [string, string];
      const rows = await client.query<{ checksum: string }>(
        `SELECT row_checksum_sha256 AS checksum FROM migration_source_${database}.snapshot_rows
         WHERE run_id=$1 AND source_schema=$2 AND source_table=$3 ORDER BY row_ordinal`,
        [runId, schema, table],
      );
      const tableHash = createHash("sha256");
      for (const row of rows.rows) tableHash.update(`${row.checksum}\n`);
      const checksum = tableHash.digest("hex");
      count += rows.rows.length;
      sourceHash.update(`${qualified}|${rows.rows.length}|${checksum}\n`);
      tables.push({
        source_database: database,
        source_schema: schema,
        source_table: table,
        status: "completed",
        row_count: rows.rows.length,
        checksum_sha256: checksum,
      });
    }
    const checksum = sourceHash.digest("hex");
    await client.query(
      `INSERT INTO platform.source_extraction_sources
       (run_id,source_database,snapshot_identifier,expected_database_name,expected_schema_fingerprint,
        actual_schema_fingerprint,status,row_count,checksum_sha256,source_snapshot_at,started_at,finished_at,duration_ms)
       VALUES($1,$2,$3,$2,$4,$4,'completed',$5,$6,$7,$7,$7,0)`,
      [runId, database, `snapshot-${database}`, "f".repeat(32), count, checksum, at],
    );
    sources.push({
      source_database: database,
      snapshot_identifier_sha256: hashSnapshotIdentifier(`snapshot-${database}`),
      expected_database_name_sha256: hashExpectedDatabaseName(database),
      expected_schema_fingerprint: "f".repeat(32),
      actual_schema_fingerprint: "f".repeat(32),
      status: "completed",
      row_count: count,
      checksum_sha256: checksum,
      source_snapshot_at: at,
    });
  }
  for (const row of tables)
    await client.query(
      `INSERT INTO platform.source_extraction_tables
       (run_id,source_database,source_schema,source_table,status,row_count,checksum_sha256,started_at,finished_at,duration_ms)
       VALUES($1,$2,$3,$4,'completed',$5,$6,$7,$7,0)`,
      [
        runId,
        row.source_database,
        row.source_schema,
        row.source_table,
        row.row_count,
        row.checksum_sha256,
        at,
      ],
    );
  return {
    run: {
      run_id: runId,
      environment: "preprod",
      source_schema_revision: VAY_1350_INVENTORY_REVISION,
      cutover_freeze_proof_sha256: null,
      status: "completed",
      finished_at: at,
    },
    sources,
    tables: tables.sort((a, b) =>
      `${a.source_database}\0${a.source_schema}\0${a.source_table}`.localeCompare(
        `${b.source_database}\0${b.source_schema}\0${b.source_table}`,
      ),
    ),
  };
}
