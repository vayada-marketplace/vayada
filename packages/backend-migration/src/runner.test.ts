import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeChecksum, discoverMigrations, runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

// ---------------------------------------------------------------------------
// Pure unit tests — no database required
// ---------------------------------------------------------------------------

describe("computeChecksum", () => {
  it("returns a stable sha256 hex string", () => {
    const content = "SELECT 1;";
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    expect(computeChecksum(content)).toBe(expected);
  });

  it("returns different checksums for different content", () => {
    expect(computeChecksum("SELECT 1;")).not.toBe(computeChecksum("SELECT 2;"));
  });

  it("is sensitive to whitespace differences", () => {
    expect(computeChecksum("SELECT 1;")).not.toBe(computeChecksum("SELECT 1; "));
  });
});

describe("discoverMigrations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `backend-migration-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for an empty directory", async () => {
    expect(await discoverMigrations(tmpDir)).toEqual([]);
  });

  it("discovers and sorts migration files by version", async () => {
    await writeFile(join(tmpDir, "0002_catalog.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const files = await discoverMigrations(tmpDir);
    expect(files.map((f) => f.version)).toEqual(["0001", "0002"]);
    expect(files[0].name).toBe("identity");
    expect(files[1].name).toBe("catalog");
  });

  it("ignores files that do not match the migration filename pattern", async () => {
    await writeFile(join(tmpDir, "seed.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "README.md"), "docs");
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const files = await discoverMigrations(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("0001_identity.sql");
  });

  it("exposes version, name, filename, and path on each result", async () => {
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const [file] = await discoverMigrations(tmpDir);
    expect(file.version).toBe("0001");
    expect(file.name).toBe("identity");
    expect(file.filename).toBe("0001_identity.sql");
    expect(file.path).toBe(join(tmpDir, "0001_identity.sql"));
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require TEST_DATABASE_URL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(__dirname, "../migrations");
const TARGET_SCHEMAS = ["platform", "identity", "hotel_catalog", "booking"];

describe.skipIf(!TEST_DATABASE_URL)("runMigrations (integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `backend-migration-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });

    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS migration_runner_test CASCADE`);
    } finally {
      await client.end();
    }
  });

  it("applies a trivial migration and records a ledger row with status applied", async () => {
    await writeFile(
      join(tmpDir, "0001_test.sql"),
      `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`,
    );

    const result = await runMigrations({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local",
      appliedBy: "test",
    });

    expect(result.applied).toEqual(["0001"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBeNull();

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{
        version: string;
        name: string;
        status: string;
        checksum_sha256: string;
        applied_by: string;
        failure_reason: string | null;
      }>(
        `SELECT version, name, status, checksum_sha256, applied_by, failure_reason
         FROM platform.schema_migrations WHERE version = '0001'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe("0001");
      expect(rows[0].name).toBe("test");
      expect(rows[0].status).toBe("applied");
      expect(rows[0].applied_by).toBe("test");
      expect(rows[0].failure_reason).toBeNull();
      expect(rows[0].checksum_sha256).toBe(
        computeChecksum(`CREATE SCHEMA IF NOT EXISTS migration_runner_test;`),
      );
    } finally {
      await client.end();
    }
  });

  it("skips an already-applied migration with matching checksum on re-run", async () => {
    await writeFile(
      join(tmpDir, "0001_test.sql"),
      `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`,
    );

    const config = {
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local" as const,
      appliedBy: "test",
    };

    await runMigrations(config);
    const second = await runMigrations(config);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001"]);
    expect(second.failed).toBeNull();
  });

  it("fails and records a ledger row when a previously applied migration file is modified", async () => {
    const filePath = join(tmpDir, "0001_test.sql");
    await writeFile(filePath, `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`);

    const config = {
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local" as const,
      appliedBy: "test",
    };

    await runMigrations(config);

    // Modify the file after it has been applied
    await writeFile(filePath, `CREATE SCHEMA IF NOT EXISTS migration_runner_test; -- tampered`);

    const result = await runMigrations(config);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBe("0001");

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ status: string; failure_reason: string }>(
        `SELECT status, failure_reason FROM platform.schema_migrations
         WHERE version = '0001' AND status = 'failed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].failure_reason).toMatch(/Checksum mismatch/);
    } finally {
      await client.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("target schema migrations (integration)", () => {
  afterEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of TARGET_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("applies booking checkout DDL and keeps summary rows free of guest PII columns", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of TARGET_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }

    const result = await runMigrations({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: REAL_MIGRATIONS_DIR,
      environment: "local",
      appliedBy: "test",
    });

    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0005");

    const verifyClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await verifyClient.connect();
    try {
      const { rows: tableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'booking'
         ORDER BY table_name`,
      );

      expect(tableRows.map((row) => row.table_name)).toEqual([
        "addon_definitions",
        "booking_addon_selections",
        "booking_change_requests",
        "booking_guests",
        "booking_notes_public",
        "booking_status_events",
        "checkout_contexts",
        "direct_booking_summary_read_model",
        "guest_bookings",
        "promo_applications",
        "quote_sessions",
      ]);

      const { rows: bookingColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'booking'
           AND (
             (table_name = 'booking_addon_selections' AND column_name = 'property_id')
             OR
             (table_name = 'checkout_contexts' AND column_name = 'converted_guest_booking_id')
           )
         ORDER BY table_name, column_name`,
      );

      expect(bookingColumns).toEqual([
        { table_name: "booking_addon_selections", column_name: "property_id" },
      ]);

      const { rows: integrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'booking'
           AND constraint_name IN (
             'uq_guest_bookings_checkout_context',
             'fk_checkout_contexts_quote_property',
             'fk_guest_bookings_quote_property',
             'fk_guest_bookings_checkout_property',
             'fk_booking_addon_selections_booking_property',
             'fk_booking_addon_selections_quote_property',
             'fk_booking_addon_selections_definition_property',
             'fk_promo_applications_quote_property',
             'fk_promo_applications_booking_property',
             'fk_direct_booking_summary_booking_property',
             'chk_promo_applications_target'
           )
         ORDER BY constraint_name`,
      );

      expect(integrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_promo_applications_target",
        "fk_booking_addon_selections_booking_property",
        "fk_booking_addon_selections_definition_property",
        "fk_booking_addon_selections_quote_property",
        "fk_checkout_contexts_quote_property",
        "fk_direct_booking_summary_booking_property",
        "fk_guest_bookings_checkout_property",
        "fk_guest_bookings_quote_property",
        "fk_promo_applications_booking_property",
        "fk_promo_applications_quote_property",
        "uq_guest_bookings_checkout_context",
      ]);

      const { rows: piiColumns } = await verifyClient.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'booking'
           AND table_name = 'direct_booking_summary_read_model'
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'special_requests', 'guest_input', 'body'
           )`,
      );

      expect(piiColumns).toHaveLength(0);
    } finally {
      await verifyClient.end();
    }
  });
});
