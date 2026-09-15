import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import {
  readLegacyOwnerBootstrapSources,
  type OwnerSourceRequest,
} from "./legacyOwnerBootstrapSourceReader.js";

const url = process.env.VAY2017_HISTORY_TEST_URL;
if (url && !/^postgresql:\/\/postgres@127\.0\.0\.1:5664[23]\/vay2017_history_test$/.test(url))
  throw Error("DISPOSABLE_HISTORY_DATABASE_REQUIRED");
const tables = [
  "migration_source_auth.snapshot_rows",
  "migration_source_pms.snapshot_rows",
  "platform.source_extraction_runs",
  "platform.source_extraction_sources",
  "platform.source_extraction_tables",
];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe.skipIf(!url)("historical evidence visibility on disposable PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: url });
  const reader = new pg.Client({ connectionString: url?.replace("postgres@", "history_reader@") });
  let input: OwnerSourceRequest;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE ROLE history_reader LOGIN;
      CREATE SCHEMA platform; CREATE SCHEMA migration_source_auth; CREATE SCHEMA migration_source_pms;
      CREATE TABLE platform.source_extraction_runs(run_id text, environment text,
        source_schema_revision text, cutover_freeze_proof_sha256 text, status text, finished_at timestamptz);
      CREATE TABLE platform.source_extraction_sources(run_id text, source_database text,
        snapshot_identifier text, expected_database_name text, expected_schema_fingerprint text,
        actual_schema_fingerprint text, status text, row_count bigint, checksum_sha256 text, source_snapshot_at timestamptz);
      CREATE TABLE platform.source_extraction_tables(run_id text, source_database text,
        source_schema text, source_table text, status text, row_count bigint, checksum_sha256 text);
      CREATE TABLE migration_source_auth.snapshot_rows(run_id text, source_schema text, source_table text,
        row_ordinal bigint, row_checksum_sha256 text, row_data jsonb, snapshot_identifier text);
      CREATE TABLE migration_source_pms.snapshot_rows(LIKE migration_source_auth.snapshot_rows);
      GRANT USAGE ON SCHEMA platform,migration_source_auth,migration_source_pms TO history_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA platform,migration_source_auth,migration_source_pms TO history_reader`);
    input = {
      sourceRunId: `vay1351-${"a".repeat(24)}`,
      sourceEnvironment: "preprod",
      sourceSchemaRevision: "a".repeat(40),
      ledgerSha256: "",
      owners: [],
    };
    await admin.query(
      `INSERT INTO platform.source_extraction_runs VALUES($1,'preprod',$2,NULL,'completed',now())`,
      [input.sourceRunId, input.sourceSchemaRevision],
    );
    for (const database of ["auth", "pms"]) {
      await admin.query(
        `INSERT INTO platform.source_extraction_sources VALUES($1,$2,'fixture','synthetic',
        repeat('c',32),repeat('c',32),'completed',8,repeat('d',64),now())`,
        [input.sourceRunId, database],
      );
    }
    // Synthetic ledger provenance; this fixture tests visibility, not extraction completeness.
    input.ledgerSha256 = hashSourceLedger(await readSourceLedger(admin, input.sourceRunId));
    for (let i = 1; i <= 8; i++) {
      const hashes: string[] = [];
      for (const database of ["auth", "pms"]) {
        const data =
          database === "auth"
            ? { id: id(i), email: `owner${i}@example.invalid`, status: "pending", type: "hotel" }
            : { id: id(i + 20), user_id: id(i) };
        const result = await admin.query(
          `INSERT INTO migration_source_${database}.snapshot_rows
          SELECT $1,'public',$2,$3,encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex'),$4::jsonb,'fixture'
          RETURNING row_checksum_sha256`,
          [input.sourceRunId, database === "auth" ? "users" : "hotels", i, JSON.stringify(data)],
        );
        hashes.push(result.rows[0].row_checksum_sha256);
      }
      input.owners.push({
        ownerId: id(i),
        hotelId: id(i + 20),
        userOrdinal: i,
        hotelOrdinal: i,
        userSha256: hashes[0]!,
        hotelSha256: hashes[1]!,
      });
    }
    await reader.connect();
    await reader.query("SET statement_timeout='3s'; SET lock_timeout='500ms'");
  });
  afterAll(async () => {
    await reader.end();
    await admin.end();
  });
  async function read() {
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return readLegacyOwnerBootstrapSources(reader, input);
  }
  async function exclusive(table: string) {
    await admin.query("BEGIN");
    try {
      await admin.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE NOWAIT`);
    } finally {
      await admin.query("ROLLBACK");
    }
  }
  it("reads eight exact pairs and retains all relation locks until caller rollback", async () => {
    try {
      expect((await read()).every((row) => row.sourceOwnership === "matched")).toBe(true);
      for (const table of tables)
        await expect(exclusive(table)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await reader.query("ROLLBACK");
    }
    for (const table of tables) await exclusive(table);
  });
  it.each(tables)("rejects RLS on %s and releases partial locks", async (table) => {
    await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    try {
      await expect(read()).rejects.toThrow(/^OWNER_SOURCE_READ_FAILED$/);
      for (const locked of tables) await exclusive(locked);
      expect((await reader.query("SELECT 1 AS usable")).rows[0].usable).toBe(1);
    } finally {
      await reader.query("ROLLBACK");
      await admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    }
  });
  it.each([false, true])(
    "rejects hidden duplicates with preexisting snapshot=%s",
    async (oldSnapshot) => {
      await admin.query(`INSERT INTO migration_source_auth.snapshot_rows SELECT run_id,source_schema,source_table,
      99,row_checksum_sha256,row_data,snapshot_identifier FROM migration_source_auth.snapshot_rows WHERE row_ordinal=1;
      CREATE POLICY hide_conflict ON migration_source_auth.snapshot_rows USING(row_ordinal<99)`);
      try {
        if (oldSnapshot) {
          await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await reader.query("SELECT count(*) FROM pg_catalog.pg_class");
        }
        await admin.query(
          "ALTER TABLE migration_source_auth.snapshot_rows ENABLE ROW LEVEL SECURITY",
        );
        if (oldSnapshot) {
          await expect(readLegacyOwnerBootstrapSources(reader, input)).rejects.toThrow(
            /^OWNER_SOURCE_READ_FAILED$/,
          );
          return;
        }
        expect(
          (await reader.query("SELECT count(*)::int AS n FROM migration_source_auth.snapshot_rows"))
            .rows[0].n,
        ).toBe(8);
        await expect(read()).rejects.toThrow(/^OWNER_SOURCE_READ_FAILED$/);
      } finally {
        await reader.query("ROLLBACK");
        await admin.query(`ALTER TABLE migration_source_auth.snapshot_rows DISABLE ROW LEVEL SECURITY;
        DROP POLICY hide_conflict ON migration_source_auth.snapshot_rows;
        DELETE FROM migration_source_auth.snapshot_rows WHERE row_ordinal=99`);
      }
    },
  );
  it.each(["view", "inheritance", "privilege", "force"])(
    "rejects %s representation",
    async (mode) => {
      const table = "platform.source_extraction_tables";
      if (mode === "view")
        await admin.query(`ALTER TABLE ${table} RENAME TO original_tables;
      CREATE VIEW ${table} AS SELECT * FROM platform.original_tables;
      GRANT SELECT ON ${table} TO history_reader`);
      if (mode === "inheritance")
        await admin.query(`CREATE TABLE platform.child_tables() INHERITS(${table})`);
      if (mode === "privilege") await admin.query(`REVOKE SELECT ON ${table} FROM history_reader`);
      if (mode === "force") await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      try {
        await expect(read()).rejects.toThrow(/^OWNER_SOURCE_READ_FAILED$/);
      } finally {
        await reader.query("ROLLBACK");
        if (mode === "view")
          await admin.query(
            `DROP VIEW ${table}; ALTER TABLE platform.original_tables RENAME TO source_extraction_tables`,
          );
        if (mode === "inheritance") await admin.query("DROP TABLE platform.child_tables");
        if (mode === "privilege") await admin.query(`GRANT SELECT ON ${table} TO history_reader`);
        if (mode === "force") await admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      }
    },
  );
  it("requires an explicit safe transaction despite a shadowed current_setting", async () => {
    await admin.query(`CREATE FUNCTION public.current_setting(text) RETURNS text LANGUAGE sql
      AS $$ SELECT CASE WHEN $1='transaction_read_only' THEN 'on' ELSE 'repeatable read' END $$`);
    await reader.query("SET search_path=public,pg_catalog");
    try {
      await expect(readLegacyOwnerBootstrapSources(reader, input)).rejects.toThrow(
        /^OWNER_SOURCE_READ_FAILED$/,
      );
      await reader.query("BEGIN");
      await expect(readLegacyOwnerBootstrapSources(reader, input)).rejects.toThrow(
        /^OWNER_SOURCE_READ_FAILED$/,
      );
    } finally {
      await reader.query("ROLLBACK; RESET search_path");
    }
  });
});
