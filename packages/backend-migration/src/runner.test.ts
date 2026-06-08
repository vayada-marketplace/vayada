import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeChecksum, discoverMigrations, runMigrations } from "./runner.js";
import { DEFAULT_TARGET_SCHEMAS } from "./targetSchemas.js";
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
      for (const schema of DEFAULT_TARGET_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("applies booking, PMS, finance, marketplace, and distribution DDL with private data boundaries", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_TARGET_SCHEMAS) {
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
    expect(result.applied).toContain("0006");
    expect(result.applied).toContain("0007");
    expect(result.applied).toContain("0008");
    expect(result.applied).toContain("0009");

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

      const { rows: pmsTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'pms'
         ORDER BY table_name`,
      );

      expect(pmsTableRows.map((row) => row.table_name)).toEqual([
        "booking_checkin_records",
        "booking_checkout_charges",
        "booking_checkout_records",
        "booking_notes_private",
        "channel_booking_mappings",
        "channel_connections",
        "channel_rate_plan_mappings",
        "channel_room_type_mappings",
        "channel_sync_status",
        "checkin_checklist_templates",
        "checkout_inspection_templates",
        "inventory_days",
        "message_attachments",
        "message_threads",
        "messages",
        "operational_booking_assignments",
        "rate_plans",
        "rate_rules",
        "room_blocks",
        "room_types",
        "rooms",
      ]);

      const { rows: pmsIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'pms'
           AND constraint_name IN (
             'chk_pms_operational_assignments_position',
             'fk_pms_operational_assignments_booking_property',
             'fk_pms_operational_assignments_room_type_property',
             'fk_pms_rate_rules_rate_plan_property',
             'fk_pms_room_blocks_room_property',
             'fk_pms_checkin_records_assignment_property',
             'fk_pms_checkout_charges_assignment_property',
             'fk_pms_checkout_records_assignment_property',
             'fk_pms_operational_assignments_rate_plan_property',
             'fk_pms_operational_assignments_room_property',
             'uq_pms_operational_assignments_booking_position',
             'uq_pms_operational_assignments_id_property_booking',
             'uq_pms_rate_plans_id_property_room_type',
             'uq_pms_rooms_id_property_room_type',
             'fk_pms_booking_notes_booking_property',
             'fk_pms_messages_thread_property',
             'fk_pms_channel_booking_mappings_booking_property',
             'fk_pms_channel_booking_mappings_assignment_property',
             'fk_pms_channel_room_mappings_connection_property',
             'fk_pms_channel_rate_mappings_rate_plan_property',
             'fk_pms_channel_sync_status_connection_property',
             'uq_pms_channel_booking_mappings_external_slot',
             'uq_pms_channel_rate_mappings_external'
           )
         ORDER BY constraint_name`,
      );

      expect(pmsIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_pms_operational_assignments_position",
        "fk_pms_booking_notes_booking_property",
        "fk_pms_channel_booking_mappings_assignment_property",
        "fk_pms_channel_booking_mappings_booking_property",
        "fk_pms_channel_rate_mappings_rate_plan_property",
        "fk_pms_channel_room_mappings_connection_property",
        "fk_pms_channel_sync_status_connection_property",
        "fk_pms_checkin_records_assignment_property",
        "fk_pms_checkout_charges_assignment_property",
        "fk_pms_checkout_records_assignment_property",
        "fk_pms_messages_thread_property",
        "fk_pms_operational_assignments_booking_property",
        "fk_pms_operational_assignments_rate_plan_property",
        "fk_pms_operational_assignments_room_property",
        "fk_pms_operational_assignments_room_type_property",
        "fk_pms_rate_rules_rate_plan_property",
        "fk_pms_room_blocks_room_property",
        "uq_pms_channel_booking_mappings_external_slot",
        "uq_pms_channel_rate_mappings_external",
        "uq_pms_operational_assignments_booking_position",
        "uq_pms_operational_assignments_id_property_booking",
        "uq_pms_rate_plans_id_property_room_type",
        "uq_pms_rooms_id_property_room_type",
      ]);

      const { rows: assignmentPositionDefaults } = await verifyClient.query<{
        default_expr: string;
      }>(
        `SELECT pg_get_expr(def.adbin, def.adrelid) AS default_expr
         FROM pg_namespace ns
         JOIN pg_class rel ON rel.relnamespace = ns.oid
         JOIN pg_attribute att ON att.attrelid = rel.oid
         JOIN pg_attrdef def
           ON def.adrelid = rel.oid
          AND def.adnum = att.attnum
         WHERE ns.nspname = 'pms'
           AND rel.relname = 'operational_booking_assignments'
           AND att.attname = 'position'`,
      );

      expect(assignmentPositionDefaults).toEqual([{ default_expr: "1" }]);

      const { rows: pmsForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'pms'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_pms_checkin_records_assignment_property',
             'fk_pms_checkout_charges_assignment_property',
             'fk_pms_checkout_records_assignment_property',
             'fk_pms_channel_booking_mappings_assignment_property',
             'fk_pms_operational_assignments_rate_plan_property',
             'fk_pms_operational_assignments_room_property',
             'fk_pms_channel_rate_mappings_rate_plan_property',
             'fk_pms_rate_rules_rate_plan_property',
             'fk_pms_room_blocks_room_property'
           )
         ORDER BY con.conname`,
      );

      expect(pmsForeignKeyShapes).toEqual([
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_channel_booking_mappings_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "channel_booking_mappings",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_channel_rate_mappings_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "channel_rate_plan_mappings",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkin_records_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkin_records",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkout_charges_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkout_charges",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkout_records_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkout_records",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_operational_assignments_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "operational_booking_assignments",
        },
        {
          columns: "room_id,property_id,room_type_id",
          constraint_name: "fk_pms_operational_assignments_room_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rooms",
          table_name: "operational_booking_assignments",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_rate_rules_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "rate_rules",
        },
        {
          columns: "room_id,property_id,room_type_id",
          constraint_name: "fk_pms_room_blocks_room_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rooms",
          table_name: "room_blocks",
        },
      ]);

      const { rows: pmsForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'pms'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('booking', 'hotel_catalog', 'identity', 'pms')
         ORDER BY tc.constraint_name`,
      );

      expect(pmsForeignKeySchemas).toHaveLength(0);

      const { rows: pmsReadModels } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'pms'
           AND table_name LIKE '%read_model%'`,
      );

      expect(pmsReadModels).toHaveLength(0);

      const { rows: financeTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'finance'
         ORDER BY table_name`,
      );

      expect(financeTableRows.map((row) => row.table_name)).toEqual([
        "billing_entitlements",
        "commission_rate_changes",
        "commission_rules",
        "finance_visibility_read_model",
        "payment_provider_accounts",
        "payment_settings",
        "payments",
        "payout_settings",
        "payouts",
      ]);

      const { rows: financeIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'finance'
           AND constraint_name IN (
             'chk_finance_billing_entitlements_source_id',
             'chk_finance_payment_provider_accounts_scope',
             'chk_finance_payment_settings_accepted_methods',
             'chk_finance_payment_settings_currency_upper',
             'chk_finance_payments_refund_amount',
             'chk_finance_payout_settings_provider_scope',
             'chk_finance_payout_settings_scope',
             'chk_finance_payouts_property_owner_related_property',
             'chk_finance_payouts_provider_scope',
             'chk_finance_payouts_related_property',
             'chk_finance_payouts_scope',
             'chk_finance_visibility_requires_permission',
             'chk_finance_visibility_scope_permission',
             'chk_finance_visibility_scope_shape',
             'fk_finance_billing_entitlements_identity_entitlement',
             'fk_finance_commission_changes_actor',
             'fk_finance_commission_changes_rule',
             'fk_finance_payment_settings_provider_account_property',
             'fk_finance_payments_booking_property',
             'fk_finance_payments_provider_account_property',
             'fk_finance_payout_settings_organization_provider_account',
             'fk_finance_payout_settings_property_provider_account',
             'fk_finance_payouts_booking_property',
             'fk_finance_payouts_organization_payout_setting',
             'fk_finance_payouts_organization_provider_account',
             'fk_finance_payouts_payment_booking',
             'fk_finance_payouts_payment_property',
             'fk_finance_payouts_property_payout_setting',
             'fk_finance_payouts_property_provider_account',
             'fk_finance_visibility_permission_key',
             'fk_finance_visibility_property',
             'uq_finance_billing_entitlements_source',
             'uq_finance_commission_rules_source',
             'uq_finance_payment_provider_accounts_id_organization',
             'uq_finance_payment_provider_accounts_id_property',
             'uq_finance_payments_id_property_booking',
             'uq_finance_payments_id_property',
             'uq_finance_payments_source',
             'uq_finance_payout_settings_id_organization',
             'uq_finance_payout_settings_id_property',
             'uq_finance_payouts_id_property',
             'uq_finance_payouts_source'
           )
         ORDER BY constraint_name`,
      );

      expect(financeIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_finance_billing_entitlements_source_id",
        "chk_finance_payment_provider_accounts_scope",
        "chk_finance_payment_settings_accepted_methods",
        "chk_finance_payment_settings_currency_upper",
        "chk_finance_payments_refund_amount",
        "chk_finance_payout_settings_provider_scope",
        "chk_finance_payout_settings_scope",
        "chk_finance_payouts_property_owner_related_property",
        "chk_finance_payouts_provider_scope",
        "chk_finance_payouts_related_property",
        "chk_finance_payouts_scope",
        "chk_finance_visibility_requires_permission",
        "chk_finance_visibility_scope_permission",
        "chk_finance_visibility_scope_shape",
        "fk_finance_billing_entitlements_identity_entitlement",
        "fk_finance_commission_changes_actor",
        "fk_finance_commission_changes_rule",
        "fk_finance_payment_settings_provider_account_property",
        "fk_finance_payments_booking_property",
        "fk_finance_payments_provider_account_property",
        "fk_finance_payout_settings_organization_provider_account",
        "fk_finance_payout_settings_property_provider_account",
        "fk_finance_payouts_booking_property",
        "fk_finance_payouts_organization_payout_setting",
        "fk_finance_payouts_organization_provider_account",
        "fk_finance_payouts_payment_booking",
        "fk_finance_payouts_payment_property",
        "fk_finance_payouts_property_payout_setting",
        "fk_finance_payouts_property_provider_account",
        "fk_finance_visibility_permission_key",
        "fk_finance_visibility_property",
        "uq_finance_billing_entitlements_source",
        "uq_finance_commission_rules_source",
        "uq_finance_payment_provider_accounts_id_organization",
        "uq_finance_payment_provider_accounts_id_property",
        "uq_finance_payments_id_property",
        "uq_finance_payments_id_property_booking",
        "uq_finance_payments_source",
        "uq_finance_payout_settings_id_organization",
        "uq_finance_payout_settings_id_property",
        "uq_finance_payouts_id_property",
        "uq_finance_payouts_source",
      ]);

      const { rows: financeForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'finance'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_finance_billing_entitlements_identity_entitlement',
             'fk_finance_commission_changes_rule',
             'fk_finance_payment_settings_provider_account_property',
             'fk_finance_payments_booking_property',
             'fk_finance_payments_provider_account_property',
             'fk_finance_payout_settings_organization_provider_account',
             'fk_finance_payout_settings_property_provider_account',
             'fk_finance_payouts_booking_property',
             'fk_finance_payouts_organization_payout_setting',
             'fk_finance_payouts_organization_provider_account',
             'fk_finance_payouts_payment_booking',
             'fk_finance_payouts_payment_property',
             'fk_finance_payouts_property_payout_setting',
             'fk_finance_payouts_property_provider_account',
             'fk_finance_visibility_permission_key',
             'fk_finance_visibility_property'
           )
         ORDER BY con.conname`,
      );

      expect(financeForeignKeyShapes).toEqual([
        {
          columns: "identity_entitlement_id",
          constraint_name: "fk_finance_billing_entitlements_identity_entitlement",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "product_entitlements",
          table_name: "billing_entitlements",
        },
        {
          columns: "commission_rule_id",
          constraint_name: "fk_finance_commission_changes_rule",
          referenced_columns: "id",
          referenced_schema: "finance",
          referenced_table: "commission_rules",
          table_name: "commission_rate_changes",
        },
        {
          columns: "provider_account_id,property_id",
          constraint_name: "fk_finance_payment_settings_provider_account_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payment_settings",
        },
        {
          columns: "guest_booking_id,property_id",
          constraint_name: "fk_finance_payments_booking_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "guest_bookings",
          table_name: "payments",
        },
        {
          columns: "provider_account_id,property_id",
          constraint_name: "fk_finance_payments_provider_account_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payments",
        },
        {
          columns: "organization_provider_account_id,organization_id",
          constraint_name: "fk_finance_payout_settings_organization_provider_account",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payout_settings",
        },
        {
          columns: "property_provider_account_id,property_id",
          constraint_name: "fk_finance_payout_settings_property_provider_account",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payout_settings",
        },
        {
          columns: "guest_booking_id,related_property_id",
          constraint_name: "fk_finance_payouts_booking_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "guest_bookings",
          table_name: "payouts",
        },
        {
          columns: "payout_setting_id,organization_id",
          constraint_name: "fk_finance_payouts_organization_payout_setting",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payout_settings",
          table_name: "payouts",
        },
        {
          columns: "organization_provider_account_id,organization_id",
          constraint_name: "fk_finance_payouts_organization_provider_account",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payouts",
        },
        {
          columns: "payment_id,related_property_id,guest_booking_id",
          constraint_name: "fk_finance_payouts_payment_booking",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "finance",
          referenced_table: "payments",
          table_name: "payouts",
        },
        {
          columns: "payment_id,related_property_id",
          constraint_name: "fk_finance_payouts_payment_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payments",
          table_name: "payouts",
        },
        {
          columns: "payout_setting_id,property_id",
          constraint_name: "fk_finance_payouts_property_payout_setting",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payout_settings",
          table_name: "payouts",
        },
        {
          columns: "property_provider_account_id,property_id",
          constraint_name: "fk_finance_payouts_property_provider_account",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payouts",
        },
        {
          columns: "required_permission_key",
          constraint_name: "fk_finance_visibility_permission_key",
          referenced_columns: "key",
          referenced_schema: "identity",
          referenced_table: "permission_catalog",
          table_name: "finance_visibility_read_model",
        },
        {
          columns: "property_id",
          constraint_name: "fk_finance_visibility_property",
          referenced_columns: "id",
          referenced_schema: "hotel_catalog",
          referenced_table: "properties",
          table_name: "finance_visibility_read_model",
        },
      ]);

      const { rows: financeForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'finance'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('booking', 'finance', 'hotel_catalog', 'identity')
         ORDER BY tc.constraint_name`,
      );

      expect(financeForeignKeySchemas).toHaveLength(0);

      const { rows: financePermissionKeys } = await verifyClient.query<{ key: string }>(
        `SELECT key
         FROM identity.permission_catalog
         WHERE key IN (
           'affiliate.payout.manage',
           'marketplace.finance.read',
           'platform.finance.read',
           'pms.finance.read'
         )
         ORDER BY key`,
      );

      expect(financePermissionKeys.map((row) => row.key)).toEqual([
        "affiliate.payout.manage",
        "marketplace.finance.read",
        "platform.finance.read",
        "pms.finance.read",
      ]);

      const organizationId = "11111111-1111-4111-8111-111111111111";
      const propertyOneId = "22222222-2222-4222-8222-222222222222";
      const propertyTwoId = "33333333-3333-4333-8333-333333333333";
      const propertyProviderAccountId = "44444444-4444-4444-8444-444444444444";
      const bookingOneId = "55555555-5555-4555-8555-555555555555";
      const bookingTwoId = "66666666-6666-4666-8666-666666666666";
      const paymentId = "77777777-7777-4777-8777-777777777777";

      await verifyClient.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Finance Test Group', 'finance-test-group')`,
        [organizationId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES
           ($1, 'finance-property-one', 'Finance Property One'),
           ($2, 'finance-property-two', 'Finance Property Two')`,
        [propertyOneId, propertyTwoId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_provider_accounts
           (id, property_id, account_scope, provider, status, onboarding_status, default_currency)
         VALUES ($1, $2, 'property', 'vayada', 'active', 'completed', 'USD')`,
        [propertyProviderAccountId, propertyOneId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_settings
           (property_id, provider_account_id, payments_enabled, accepted_methods, default_currency)
         VALUES (
           $1,
           $2,
           TRUE,
           ARRAY['card', 'pay_at_property', 'xendit', 'manual_card', 'other']::TEXT[],
           'USD'
         )`,
        [propertyOneId, propertyProviderAccountId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payment_settings
             (property_id, provider_account_id, default_currency)
           VALUES ($1, $2, 'USD')`,
          [propertyTwoId, propertyProviderAccountId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
         VALUES
           ($1, $2, 'FIN-BOOKING-ONE', 'confirmed', DATE '2026-01-01', DATE '2026-01-02', 'USD'),
           ($3, $2, 'FIN-BOOKING-TWO', 'confirmed', DATE '2026-01-03', DATE '2026-01-04', 'USD')`,
        [bookingOneId, propertyOneId, bookingTwoId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payments
           (id, property_id, guest_booking_id, payment_kind, status, amount, net_amount, currency)
         VALUES ($1, $2, $3, 'full', 'paid', 100, 95, 'USD')`,
        [paymentId, propertyOneId, bookingOneId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payouts
           (
             owner_scope, organization_id, related_property_id, payment_id,
             guest_booking_id, payout_status, amount, net_amount, currency
           )
         VALUES ('organization', $1, $2, $3, $4, 'paid', 100, 95, 'USD')`,
        [organizationId, propertyOneId, paymentId, bookingOneId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payouts
             (owner_scope, organization_id, payment_id, payout_status, amount, currency)
           VALUES ('organization', $1, $2, 'paid', 100, 'USD')`,
          [organizationId, paymentId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payouts
             (
               owner_scope, organization_id, related_property_id, payment_id,
               guest_booking_id, payout_status, amount, currency
             )
           VALUES ('organization', $1, $2, $3, $4, 'paid', 100, 'USD')`,
          [organizationId, propertyOneId, paymentId, bookingTwoId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO finance.finance_visibility_read_model
           (
             organization_id, property_id, visibility_scope, resource_type,
             resource_id, required_permission_key, currency
           )
         VALUES ($1, $2, 'property_finance', 'property', $3, 'pms.finance.read', 'USD')`,
        [organizationId, propertyOneId, propertyOneId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.finance_visibility_read_model
             (
               organization_id, visibility_scope, resource_type,
               resource_id, required_permission_key, currency
             )
           VALUES ($1, 'platform_finance', 'platform', 'platform', 'pms.finance.read', 'USD')`,
          [organizationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const { rows: financeVisibilityPermissionColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'finance'
           AND table_name = 'finance_visibility_read_model'
           AND column_name IN ('visibility_scope', 'required_permission_key')
         ORDER BY ordinal_position`,
      );

      expect(financeVisibilityPermissionColumns).toEqual([
        { column_name: "visibility_scope" },
        { column_name: "required_permission_key" },
      ]);

      const { rows: financeVisibilitySensitiveColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'finance'
           AND table_name = 'finance_visibility_read_model'
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'guest_name', 'guest_email', 'provider_account_id',
             'provider_transaction_id', 'provider_payment_intent_id',
             'billing_customer_ref', 'billing_subscription_ref',
             'sensitive_config_ref', 'sensitive_destination_ref',
             'processor_fee_breakdown', 'risk_review', 'raw_payload'
           )`,
      );

      expect(financeVisibilitySensitiveColumns).toHaveLength(0);

      const { rows: marketplaceTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'marketplace'
         ORDER BY table_name`,
      );

      expect(marketplaceTableRows.map((row) => row.table_name)).toEqual([
        "collaboration_deliverables",
        "collaborations",
        "creator_platforms",
        "creator_profiles",
        "creator_ratings",
        "external_collaborations",
        "invite_codes",
        "listing_collaboration_offerings",
        "listing_creator_requirements",
        "marketplace_chat_messages",
        "marketplace_hotel_listings",
        "marketplace_hotel_profiles",
        "marketplace_listing_read_model",
        "marketplace_notifications",
        "newsletter_preferences",
        "trips",
      ]);

      const { rows: marketplaceIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'marketplace'
           AND constraint_name IN (
             'chk_marketplace_chat_sender_shape',
             'chk_marketplace_collaborations_currency_upper',
             'chk_marketplace_collaborations_preferred_dates',
             'chk_marketplace_collaborations_source_id',
             'chk_marketplace_collaborations_status',
             'chk_marketplace_collaborations_travel_dates',
             'chk_marketplace_collaborations_type_terms',
             'chk_marketplace_creator_platform_engagement',
             'chk_marketplace_creator_platform_followers',
             'chk_marketplace_creator_platforms_source_id',
             'chk_marketplace_creator_profiles_source_id',
             'chk_marketplace_creator_ratings_score',
             'chk_marketplace_deliverables_quantity',
             'chk_marketplace_external_collaborations_date_order',
             'chk_marketplace_external_collaborations_source_id',
             'chk_marketplace_hotel_listings_source_id',
             'chk_marketplace_hotel_listings_status',
             'chk_marketplace_hotel_profiles_source_id',
             'chk_marketplace_hotel_profiles_status',
             'chk_marketplace_invite_codes_dates',
             'chk_marketplace_invite_codes_status',
             'chk_marketplace_listing_read_model_public_json',
             'chk_marketplace_newsletter_preferences_source_id',
             'chk_marketplace_offerings_currency_upper',
             'chk_marketplace_offerings_source_id',
             'chk_marketplace_offerings_type_terms',
             'chk_marketplace_requirements_age_range',
             'chk_marketplace_requirements_source_id',
             'chk_marketplace_trips_date_order',
             'chk_marketplace_trips_source_id',
             'fk_marketplace_chat_collaboration_property',
             'fk_marketplace_collaborations_commission_rule',
             'fk_marketplace_collaborations_creator_org',
             'fk_marketplace_collaborations_listing_org',
             'fk_marketplace_creator_platforms_creator_org',
             'fk_marketplace_deliverables_collaboration_property',
             'fk_marketplace_external_collaborations_creator_org',
             'fk_marketplace_external_collaborations_trip_creator',
             'fk_marketplace_hotel_listings_profile_org',
             'fk_marketplace_invite_codes_creator_org',
             'fk_marketplace_offerings_listing_org',
             'fk_marketplace_ratings_collaboration_creator',
             'fk_marketplace_ratings_creator_org',
             'fk_marketplace_ratings_hotel_profile_org',
             'fk_marketplace_read_model_listing_property',
             'fk_marketplace_read_model_property',
             'fk_marketplace_requirements_listing_org',
             'fk_marketplace_trips_creator_org',
             'uq_marketplace_collaborations_id_property',
             'uq_marketplace_collaborations_id_property_creator',
             'uq_marketplace_collaborations_source',
             'uq_marketplace_creator_platforms_source',
             'uq_marketplace_creator_profiles_id_org',
             'uq_marketplace_creator_profiles_source',
             'uq_marketplace_creator_ratings_collaboration',
             'uq_marketplace_external_collaborations_source',
             'uq_marketplace_hotel_listings_id_property',
             'uq_marketplace_hotel_listings_id_property_org',
             'uq_marketplace_hotel_listings_source',
             'uq_marketplace_hotel_profiles_property_org',
             'uq_marketplace_hotel_profiles_source',
             'uq_marketplace_newsletter_preferences_source',
             'uq_marketplace_offerings_source',
             'uq_marketplace_requirements_listing',
             'uq_marketplace_requirements_source',
             'uq_marketplace_trips_id_creator',
             'uq_marketplace_trips_source'
           )
         ORDER BY constraint_name`,
      );

      expect(marketplaceIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_marketplace_chat_sender_shape",
        "chk_marketplace_collaborations_currency_upper",
        "chk_marketplace_collaborations_preferred_dates",
        "chk_marketplace_collaborations_source_id",
        "chk_marketplace_collaborations_status",
        "chk_marketplace_collaborations_travel_dates",
        "chk_marketplace_collaborations_type_terms",
        "chk_marketplace_creator_platform_engagement",
        "chk_marketplace_creator_platform_followers",
        "chk_marketplace_creator_platforms_source_id",
        "chk_marketplace_creator_profiles_source_id",
        "chk_marketplace_creator_ratings_score",
        "chk_marketplace_deliverables_quantity",
        "chk_marketplace_external_collaborations_date_order",
        "chk_marketplace_external_collaborations_source_id",
        "chk_marketplace_hotel_listings_source_id",
        "chk_marketplace_hotel_listings_status",
        "chk_marketplace_hotel_profiles_source_id",
        "chk_marketplace_hotel_profiles_status",
        "chk_marketplace_invite_codes_dates",
        "chk_marketplace_invite_codes_status",
        "chk_marketplace_listing_read_model_public_json",
        "chk_marketplace_newsletter_preferences_source_id",
        "chk_marketplace_offerings_currency_upper",
        "chk_marketplace_offerings_source_id",
        "chk_marketplace_offerings_type_terms",
        "chk_marketplace_requirements_age_range",
        "chk_marketplace_requirements_source_id",
        "chk_marketplace_trips_date_order",
        "chk_marketplace_trips_source_id",
        "fk_marketplace_chat_collaboration_property",
        "fk_marketplace_collaborations_commission_rule",
        "fk_marketplace_collaborations_creator_org",
        "fk_marketplace_collaborations_listing_org",
        "fk_marketplace_creator_platforms_creator_org",
        "fk_marketplace_deliverables_collaboration_property",
        "fk_marketplace_external_collaborations_creator_org",
        "fk_marketplace_external_collaborations_trip_creator",
        "fk_marketplace_hotel_listings_profile_org",
        "fk_marketplace_invite_codes_creator_org",
        "fk_marketplace_offerings_listing_org",
        "fk_marketplace_ratings_collaboration_creator",
        "fk_marketplace_ratings_creator_org",
        "fk_marketplace_ratings_hotel_profile_org",
        "fk_marketplace_read_model_listing_property",
        "fk_marketplace_read_model_property",
        "fk_marketplace_requirements_listing_org",
        "fk_marketplace_trips_creator_org",
        "uq_marketplace_collaborations_id_property",
        "uq_marketplace_collaborations_id_property_creator",
        "uq_marketplace_collaborations_source",
        "uq_marketplace_creator_platforms_source",
        "uq_marketplace_creator_profiles_id_org",
        "uq_marketplace_creator_profiles_source",
        "uq_marketplace_creator_ratings_collaboration",
        "uq_marketplace_external_collaborations_source",
        "uq_marketplace_hotel_listings_id_property",
        "uq_marketplace_hotel_listings_id_property_org",
        "uq_marketplace_hotel_listings_source",
        "uq_marketplace_hotel_profiles_property_org",
        "uq_marketplace_hotel_profiles_source",
        "uq_marketplace_newsletter_preferences_source",
        "uq_marketplace_offerings_source",
        "uq_marketplace_requirements_listing",
        "uq_marketplace_requirements_source",
        "uq_marketplace_trips_id_creator",
        "uq_marketplace_trips_source",
      ]);

      const { rows: marketplaceForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'marketplace'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_marketplace_chat_collaboration_property',
             'fk_marketplace_collaborations_commission_rule',
             'fk_marketplace_collaborations_creator_org',
             'fk_marketplace_collaborations_listing_org',
             'fk_marketplace_creator_platforms_creator_org',
             'fk_marketplace_deliverables_collaboration_property',
             'fk_marketplace_external_collaborations_trip_creator',
             'fk_marketplace_hotel_listings_profile_org',
             'fk_marketplace_invite_codes_creator_org',
             'fk_marketplace_offerings_listing_org',
             'fk_marketplace_ratings_collaboration_creator',
             'fk_marketplace_read_model_listing_property',
             'fk_marketplace_requirements_listing_org',
             'fk_marketplace_trips_creator_org'
           )
         ORDER BY con.conname`,
      );

      expect(marketplaceForeignKeyShapes).toEqual([
        {
          columns: "collaboration_id,property_id",
          constraint_name: "fk_marketplace_chat_collaboration_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "marketplace_chat_messages",
        },
        {
          columns: "commission_rule_id,hotel_organization_id",
          constraint_name: "fk_marketplace_collaborations_commission_rule",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "commission_rules",
          table_name: "collaborations",
        },
        {
          columns: "creator_profile_id,creator_organization_id",
          constraint_name: "fk_marketplace_collaborations_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "collaborations",
        },
        {
          columns: "listing_id,property_id,hotel_organization_id",
          constraint_name: "fk_marketplace_collaborations_listing_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_listings",
          table_name: "collaborations",
        },
        {
          columns: "creator_profile_id,organization_id",
          constraint_name: "fk_marketplace_creator_platforms_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "creator_platforms",
        },
        {
          columns: "collaboration_id,property_id",
          constraint_name: "fk_marketplace_deliverables_collaboration_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "collaboration_deliverables",
        },
        {
          columns: "trip_id,creator_profile_id",
          constraint_name: "fk_marketplace_external_collaborations_trip_creator",
          referenced_columns: "id,creator_profile_id",
          referenced_schema: "marketplace",
          referenced_table: "trips",
          table_name: "external_collaborations",
        },
        {
          columns: "property_id,organization_id",
          constraint_name: "fk_marketplace_hotel_listings_profile_org",
          referenced_columns: "property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_profiles",
          table_name: "marketplace_hotel_listings",
        },
        {
          columns: "creator_profile_id,creator_organization_id",
          constraint_name: "fk_marketplace_invite_codes_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "invite_codes",
        },
        {
          columns: "listing_id,property_id,organization_id",
          constraint_name: "fk_marketplace_offerings_listing_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_listings",
          table_name: "listing_collaboration_offerings",
        },
        {
          columns: "collaboration_id,property_id,creator_profile_id",
          constraint_name: "fk_marketplace_ratings_collaboration_creator",
          referenced_columns: "id,property_id,creator_profile_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "creator_ratings",
        },
        {
          columns: "listing_id,property_id",
          constraint_name: "fk_marketplace_read_model_listing_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_listings",
          table_name: "marketplace_listing_read_model",
        },
        {
          columns: "listing_id,property_id,organization_id",
          constraint_name: "fk_marketplace_requirements_listing_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_listings",
          table_name: "listing_creator_requirements",
        },
        {
          columns: "creator_profile_id,organization_id",
          constraint_name: "fk_marketplace_trips_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "trips",
        },
      ]);

      const { rows: marketplaceForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'marketplace'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('finance', 'hotel_catalog', 'identity', 'marketplace')
         ORDER BY tc.constraint_name`,
      );

      expect(marketplaceForeignKeySchemas).toHaveLength(0);

      const { rows: marketplaceReadModelSensitiveColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'marketplace'
             AND table_name = 'marketplace_listing_read_model'
             AND column_name IN (
               'email', 'phone', 'user_id', 'created_by_user_id', 'redeemed_by_user_id',
               'body', 'content', 'message_body', 'message_metadata',
               'application_message', 'negotiated_terms', 'affiliate_link',
               'affiliate_referral_code', 'creator_fee', 'organization_id', 'private_notes',
               'pii_retention_until'
             )`,
      );

      expect(marketplaceReadModelSensitiveColumns).toHaveLength(0);

      const creatorUserId = "99999999-1111-4111-8111-999999999991";
      const hotelUserId = "99999999-1111-4111-8111-999999999992";
      const creatorOrganizationId = "99999999-2222-4222-8222-999999999991";
      const hotelOrganizationId = "99999999-2222-4222-8222-999999999992";
      const wrongOrganizationId = "99999999-2222-4222-8222-999999999993";
      const marketplacePropertyId = "99999999-3333-4333-8333-999999999991";
      const creatorProfileId = "99999999-4444-4444-8444-999999999991";
      const listingId = "99999999-5555-4555-8555-999999999991";
      const commissionRuleId = "99999999-6666-4666-8666-999999999991";
      const wrongCommissionRuleId = "99999999-6666-4666-8666-999999999992";
      const marketplaceCollaborationId = "99999999-7777-4777-8777-999999999991";

      await verifyClient.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES
           ($1, 'marketplace-creator@example.com', 'Marketplace Creator', 'active'),
           ($2, 'marketplace-hotel@example.com', 'Marketplace Hotel', 'active')`,
        [creatorUserId, hotelUserId],
      );
      await verifyClient.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES
           ($1, 'creator_workspace', 'Marketplace Creator Workspace', 'marketplace-creator-workspace'),
           ($2, 'hotel_group', 'Marketplace Hotel Group', 'marketplace-hotel-group'),
           ($3, 'hotel_group', 'Marketplace Wrong Hotel Group', 'marketplace-wrong-hotel-group')`,
        [creatorOrganizationId, hotelOrganizationId, wrongOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'marketplace-property-one', 'Marketplace Property One')`,
        [marketplacePropertyId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.creator_profiles
           (id, organization_id, owner_user_id, display_name, creator_type, profile_status)
         VALUES ($1, $2, $3, 'Marketplace Creator', 'travel', 'active')`,
        [creatorProfileId, creatorOrganizationId, creatorUserId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.creator_platforms
           (creator_profile_id, organization_id, platform, handle, follower_count, engagement_rate)
         VALUES ($1, $2, 'instagram', '@marketplace_creator', 125000, 3.2)`,
        [creatorProfileId, creatorOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles
           (property_id, organization_id, marketplace_profile_status, profile_complete)
         VALUES ($1, $2, 'verified', TRUE)`,
        [marketplacePropertyId, hotelOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_hotel_listings
           (id, property_id, organization_id, title, listing_summary, accommodation_type, listing_status)
         VALUES ($1, $2, $3, 'Creator Stay Listing', 'Public collaboration listing.', 'hotel', 'verified')`,
        [listingId, marketplacePropertyId, hotelOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.listing_collaboration_offerings
           (listing_id, property_id, organization_id, collaboration_type, commission_percentage, currency)
         VALUES ($1, $2, $3, 'affiliate', 12.5, 'USD')`,
        [listingId, marketplacePropertyId, hotelOrganizationId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.listing_collaboration_offerings
             (listing_id, property_id, organization_id, collaboration_type, commission_percentage, currency)
           VALUES ($1, $2, $3, 'affiliate', 12.5, 'USD')`,
          [listingId, marketplacePropertyId, wrongOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO finance.commission_rules
           (id, organization_id, rule_scope, product, commission_type, percentage_rate)
         VALUES
           ($1, $2, 'marketplace', 'marketplace', 'percentage', 12.5),
           ($3, $4, 'marketplace', 'marketplace', 'percentage', 12.5)`,
        [commissionRuleId, hotelOrganizationId, wrongCommissionRuleId, wrongOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.collaborations
           (
             id, creator_profile_id, creator_organization_id, property_id,
             hotel_organization_id, listing_id, commission_rule_id,
             initiator_type, lifecycle_status, collaboration_type,
             creator_fee, currency, creator_consent
           )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'creator', 'pending', 'affiliate', 12.5, 'USD', TRUE
         )`,
        [
          marketplaceCollaborationId,
          creatorProfileId,
          creatorOrganizationId,
          marketplacePropertyId,
          hotelOrganizationId,
          listingId,
          commissionRuleId,
        ],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, listing_id, initiator_type,
               lifecycle_status, collaboration_type, creator_fee, currency
             )
           VALUES ($1, $2, $3, $4, $5, 'creator', 'pending', 'affiliate', 12.5, 'USD')`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            hotelOrganizationId,
            listingId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, listing_id, initiator_type,
               lifecycle_status, collaboration_type, creator_fee, currency,
               creator_consent
             )
           VALUES ($1, $2, $3, $4, $5, 'creator', 'declined', 'affiliate', 12.5, 'USD', TRUE)`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            wrongOrganizationId,
            listingId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, listing_id, commission_rule_id,
               initiator_type, lifecycle_status, collaboration_type,
               creator_fee, currency, creator_consent
             )
           VALUES (
             $1, $2, $3, $4, $5, $6,
             'creator', 'declined', 'affiliate', 12.5, 'USD', TRUE
           )`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            hotelOrganizationId,
            listingId,
            wrongCommissionRuleId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_listing_read_model
           (
             listing_id, property_id, public_id,
             canonical_slug, display_name, listing_title, listing_summary,
             accommodation_type, visibility_status
           )
         VALUES (
           $1, $2, 'marketplace-property-one', 'marketplace-property-one',
           'Marketplace Property One', 'Creator Stay Listing',
           'Public collaboration listing.', 'hotel', 'public'
         )`,
        [listingId, marketplacePropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE marketplace.marketplace_listing_read_model
           SET public_offering_summary = $1::jsonb
           WHERE listing_id = $2`,
          [
            JSON.stringify([
              {
                type: "affiliate",
                terms: { affiliateLink: "https://private.example/affiliate" },
              },
            ]),
            listingId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const { rows: distributionTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'distribution'
         ORDER BY table_name`,
      );

      expect(distributionTableRows.map((row) => row.table_name)).toEqual([
        "booking_deep_link_contexts",
        "external_api_clients",
        "external_api_usage_events",
        "public_hotel_bookability_profiles",
        "public_quote_read_models",
        "public_room_offer_snapshots",
      ]);

      const { rows: distributionIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'distribution'
           AND constraint_name IN (
             'chk_distribution_bookability_profiles_contract',
             'chk_distribution_bookability_profiles_currency_upper',
             'chk_distribution_bookability_profiles_finance_property',
             'chk_distribution_bookability_profiles_locale_supported',
             'chk_distribution_bookability_profiles_public_json',
             'chk_distribution_bookability_profiles_public_visibility',
             'chk_distribution_bookability_profiles_sources',
             'chk_distribution_bookability_profiles_timezone',
             'chk_distribution_deep_link_contexts_checkout_quote_pair',
             'chk_distribution_deep_link_contexts_currency_upper',
             'chk_distribution_deep_link_contexts_date_order',
             'chk_distribution_deep_link_contexts_preserves',
             'chk_distribution_deep_link_contexts_public_json',
             'chk_distribution_external_api_clients_public_metadata',
             'chk_distribution_external_api_clients_revocation',
             'chk_distribution_external_api_clients_surfaces',
             'chk_distribution_quote_read_models_contract',
             'chk_distribution_quote_read_models_currency_upper',
             'chk_distribution_quote_read_models_public_json',
             'chk_distribution_quote_read_models_public_visibility',
             'chk_distribution_quote_read_models_sources',
             'chk_distribution_room_offer_snapshots_contract',
             'chk_distribution_room_offer_snapshots_currency_upper',
             'chk_distribution_room_offer_snapshots_payment_options',
             'chk_distribution_room_offer_snapshots_public_json',
             'chk_distribution_room_offer_snapshots_public_visibility',
             'chk_distribution_room_offer_snapshots_sources',
             'chk_distribution_usage_events_deep_link_property',
             'chk_distribution_usage_events_public_metadata',
             'chk_distribution_usage_events_quote_property',
             'fk_distribution_bookability_profiles_catalog_profile',
             'fk_distribution_bookability_profiles_finance_settings',
             'fk_distribution_deep_link_contexts_bookability_profile',
             'fk_distribution_deep_link_contexts_checkout_property',
             'fk_distribution_deep_link_contexts_quote_property',
             'fk_distribution_quote_read_models_bookability_profile',
             'fk_distribution_quote_read_models_quote_property',
             'fk_distribution_room_offer_snapshots_bookability_profile',
             'fk_distribution_room_offer_snapshots_inventory_day',
             'fk_distribution_room_offer_snapshots_rate_plan',
             'fk_distribution_usage_events_deep_link_property',
             'fk_distribution_usage_events_quote_property',
             'uq_distribution_bookability_profiles_public_id',
             'uq_distribution_deep_link_contexts_id_property',
             'uq_distribution_deep_link_contexts_token_hash',
             'uq_distribution_external_api_clients_public_id',
             'uq_distribution_quote_read_models_public_reference',
             'uq_distribution_room_offer_snapshots_id_property',
             'uq_distribution_room_offer_snapshots_offer_date'
           )
         ORDER BY constraint_name`,
      );

      expect(distributionIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_distribution_bookability_profiles_contract",
        "chk_distribution_bookability_profiles_currency_upper",
        "chk_distribution_bookability_profiles_finance_property",
        "chk_distribution_bookability_profiles_locale_supported",
        "chk_distribution_bookability_profiles_public_json",
        "chk_distribution_bookability_profiles_public_visibility",
        "chk_distribution_bookability_profiles_sources",
        "chk_distribution_bookability_profiles_timezone",
        "chk_distribution_deep_link_contexts_checkout_quote_pair",
        "chk_distribution_deep_link_contexts_currency_upper",
        "chk_distribution_deep_link_contexts_date_order",
        "chk_distribution_deep_link_contexts_preserves",
        "chk_distribution_deep_link_contexts_public_json",
        "chk_distribution_external_api_clients_public_metadata",
        "chk_distribution_external_api_clients_revocation",
        "chk_distribution_external_api_clients_surfaces",
        "chk_distribution_quote_read_models_contract",
        "chk_distribution_quote_read_models_currency_upper",
        "chk_distribution_quote_read_models_public_json",
        "chk_distribution_quote_read_models_public_visibility",
        "chk_distribution_quote_read_models_sources",
        "chk_distribution_room_offer_snapshots_contract",
        "chk_distribution_room_offer_snapshots_currency_upper",
        "chk_distribution_room_offer_snapshots_payment_options",
        "chk_distribution_room_offer_snapshots_public_json",
        "chk_distribution_room_offer_snapshots_public_visibility",
        "chk_distribution_room_offer_snapshots_sources",
        "chk_distribution_usage_events_deep_link_property",
        "chk_distribution_usage_events_public_metadata",
        "chk_distribution_usage_events_quote_property",
        "fk_distribution_bookability_profiles_catalog_profile",
        "fk_distribution_bookability_profiles_finance_settings",
        "fk_distribution_deep_link_contexts_bookability_profile",
        "fk_distribution_deep_link_contexts_checkout_property",
        "fk_distribution_deep_link_contexts_quote_property",
        "fk_distribution_quote_read_models_bookability_profile",
        "fk_distribution_quote_read_models_quote_property",
        "fk_distribution_room_offer_snapshots_bookability_profile",
        "fk_distribution_room_offer_snapshots_inventory_day",
        "fk_distribution_room_offer_snapshots_rate_plan",
        "fk_distribution_usage_events_deep_link_property",
        "fk_distribution_usage_events_quote_property",
        "uq_distribution_bookability_profiles_public_id",
        "uq_distribution_deep_link_contexts_id_property",
        "uq_distribution_deep_link_contexts_token_hash",
        "uq_distribution_external_api_clients_public_id",
        "uq_distribution_quote_read_models_public_reference",
        "uq_distribution_room_offer_snapshots_id_property",
        "uq_distribution_room_offer_snapshots_offer_date",
      ]);

      const { rows: distributionForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'distribution'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_distribution_bookability_profiles_catalog_profile',
             'fk_distribution_bookability_profiles_finance_settings',
             'fk_distribution_deep_link_contexts_bookability_profile',
             'fk_distribution_deep_link_contexts_checkout_property',
             'fk_distribution_deep_link_contexts_quote_property',
             'fk_distribution_quote_read_models_bookability_profile',
             'fk_distribution_quote_read_models_quote_property',
             'fk_distribution_room_offer_snapshots_bookability_profile',
             'fk_distribution_room_offer_snapshots_inventory_day',
             'fk_distribution_room_offer_snapshots_rate_plan',
             'fk_distribution_usage_events_deep_link_property',
             'fk_distribution_usage_events_quote_property'
           )
         ORDER BY con.conname`,
      );

      expect(distributionForeignKeyShapes).toEqual([
        {
          columns: "property_id",
          constraint_name: "fk_distribution_bookability_profiles_catalog_profile",
          referenced_columns: "property_id",
          referenced_schema: "hotel_catalog",
          referenced_table: "property_public_profile_read_model",
          table_name: "public_hotel_bookability_profiles",
        },
        {
          columns: "finance_payment_settings_property_id",
          constraint_name: "fk_distribution_bookability_profiles_finance_settings",
          referenced_columns: "property_id",
          referenced_schema: "finance",
          referenced_table: "payment_settings",
          table_name: "public_hotel_bookability_profiles",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_deep_link_contexts_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "checkout_context_id,property_id,quote_session_id",
          constraint_name: "fk_distribution_deep_link_contexts_checkout_property",
          referenced_columns: "id,property_id,quote_session_id",
          referenced_schema: "booking",
          referenced_table: "checkout_contexts",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_deep_link_contexts_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_quote_read_models_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "public_quote_read_models",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_quote_read_models_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "public_quote_read_models",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_room_offer_snapshots_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "property_id,room_type_id,stay_date",
          constraint_name: "fk_distribution_room_offer_snapshots_inventory_day",
          referenced_columns: "property_id,room_type_id,stay_date",
          referenced_schema: "pms",
          referenced_table: "inventory_days",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_distribution_room_offer_snapshots_rate_plan",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "deep_link_context_id,property_id",
          constraint_name: "fk_distribution_usage_events_deep_link_property",
          referenced_columns: "id,property_id",
          referenced_schema: "distribution",
          referenced_table: "booking_deep_link_contexts",
          table_name: "external_api_usage_events",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_usage_events_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "external_api_usage_events",
        },
      ]);

      const { rows: distributionForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'distribution'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('booking', 'distribution', 'finance', 'hotel_catalog', 'identity', 'pms')
         ORDER BY tc.constraint_name`,
      );

      expect(distributionForeignKeySchemas).toHaveLength(0);

      const { rows: distributionReadModelSensitiveColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'distribution'
           AND table_name IN (
             'public_hotel_bookability_profiles',
             'public_room_offer_snapshots',
             'public_quote_read_models'
           )
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'guest_name', 'guest_email', 'guest_phone',
             'special_requests', 'private_notes', 'message_body',
             'provider_account_id', 'provider_transaction_id',
             'provider_payment_intent_id', 'payout_setting_id',
             'commission_rule_id', 'room_id', 'room_number',
             'assignment_id', 'channel_connection_id', 'raw_payload',
             'raw_headers', 'raw_body'
           )`,
      );

      expect(distributionReadModelSensitiveColumns).toHaveLength(0);

      const { rows: externalApiSecretColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'distribution'
           AND table_name = 'external_api_clients'
           AND column_name IN (
             'api_key', 'secret', 'client_secret',
             'raw_secret', 'token', 'access_token'
           )`,
      );

      expect(externalApiSecretColumns).toHaveLength(0);

      const distributionUserId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
      const distributionPropertyId = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaa1";
      const distributionRoomTypeId = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaa1";
      const distributionRatePlanId = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaa1";
      const distributionQuoteSessionId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa1";
      const distributionCheckoutContextId = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaa1";
      const distributionDeepLinkContextId = "aaaaaaaa-7777-4777-8777-aaaaaaaaaaa1";
      const distributionClientId = "aaaaaaaa-8888-4888-8888-aaaaaaaaaaa1";
      const distributionMismatchQuoteSessionId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa2";
      const distributionMismatchCheckoutContextId = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaa2";

      await verifyClient.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1, 'distribution-client-admin@example.com', 'Distribution Client Admin', 'active')`,
        [distributionUserId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, default_locale, supported_locales, profile_status)
         VALUES ($1, 'distribution-property-one', 'Distribution Property One', 'en', ARRAY['en', 'de']::TEXT[], 'complete')`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (
             property_id, public_id, display_name, canonical_slug,
             default_locale, supported_locales, profile_status,
             location, descriptions, media, amenities, public_policy,
             source_freshness
           )
         VALUES (
           $1, 'distribution-property-one', 'Distribution Property One',
           'distribution-property-one', 'en', ARRAY['en', 'de']::TEXT[],
           'complete',
           '{"country":"US","city":"Austin","timezone":"America/Chicago"}'::jsonb,
           '{"summary":"Public distribution test property."}'::jsonb,
           '[]'::jsonb,
           '["wifi"]'::jsonb,
           '{"checkInFrom":"15:00","checkOutUntil":"11:00"}'::jsonb,
           '{"sources":[{"owner":"hotel_catalog","status":"fresh"}]}'::jsonb
         )`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_settings
           (property_id, payments_enabled, accepted_methods, default_currency)
         VALUES ($1, TRUE, ARRAY['card', 'pay_at_property']::TEXT[], 'USD')`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
           (
             property_id, finance_payment_settings_property_id, public_id,
             canonical_slug, canonical_url, booking_base_url, timezone,
             default_locale, supported_locales, default_currency,
             supported_currencies, profile_status, public_identity,
             capabilities, supported_quote_parameters, source_freshness,
             freshness_status, data_sources
           )
         VALUES (
             $1, $1, 'distribution-property-one',
             'distribution-property-one',
             'https://distribution-property-one.booking.localhost/en',
             'https://distribution-property-one.booking.localhost',
             'America/Chicago', 'en', ARRAY['en', 'de']::TEXT[],
             'USD', ARRAY['USD']::TEXT[], 'public',
             '{"name":"Distribution Property One"}'::jsonb,
             '{"instantBook":true,"onlinePayment":true}'::jsonb,
             '{"minRooms":1,"maxRooms":3,"minAdults":1,"maxAdults":6}'::jsonb,
             '{"sources":[{"owner":"hotel_catalog","status":"fresh"},{"owner":"finance","status":"fresh"}]}'::jsonb,
             'fresh',
             ARRAY['hotel_catalog', 'finance', 'distribution']::TEXT[]
         )`,
        [distributionPropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE distribution.public_hotel_bookability_profiles
           SET source_freshness = $1::jsonb
           WHERE property_id = $2`,
          [
            JSON.stringify({
              sources: [{ owner: "booking", guestEmail: "guest@example.com" }],
            }),
            distributionPropertyId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO pms.room_types
           (id, property_id, name, description, base_rate_amount, currency)
         VALUES ($1, $2, 'Public Suite', 'Public suite description.', 200, 'USD')`,
        [distributionRoomTypeId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO pms.rate_plans
           (id, property_id, room_type_id, code, name, base_rate_amount, currency)
         VALUES ($1, $2, $3, 'FLEX', 'Flexible public rate', 200, 'USD')`,
        [distributionRatePlanId, distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO pms.inventory_days
           (property_id, room_type_id, stay_date, total_count, available_count, source_freshness)
         VALUES (
           $1, $2, DATE '2026-03-01', 5, 4,
           '{"sources":[{"owner":"pms","status":"fresh"}]}'::jsonb
         )`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_room_offer_snapshots
           (
             property_id, room_type_id, rate_plan_id, stay_date,
             public_offer_key, available_rooms, base_price_amount,
             taxes_and_fees_amount, currency, occupancy,
             room_summary, rate_summary, payment_options,
             public_policy, source_freshness, freshness_status
           )
         VALUES (
           $1, $2, $3, DATE '2026-03-01',
           'suite-flex-2026-03-01', 4, 200, 20, 'USD',
           '{"maxAdults":2,"maxChildren":1}'::jsonb,
           '{"name":"Public Suite"}'::jsonb,
           '{"name":"Flexible public rate","refundable":true}'::jsonb,
           ARRAY['card', 'pay_at_property']::TEXT[],
           '{"cancellation":"Free cancellation summary."}'::jsonb,
           '{"sources":[{"owner":"pms","status":"fresh"}]}'::jsonb,
           'fresh'
         )`,
        [distributionPropertyId, distributionRoomTypeId, distributionRatePlanId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.public_room_offer_snapshots
             (
               property_id, room_type_id, rate_plan_id, stay_date,
               public_offer_key, currency
             )
           VALUES ($1, $2, $3, DATE '2026-03-01', 'bad-rate-plan', 'USD')`,
          [distributionPropertyId, distributionRoomTypeId, "aaaaaaaa-4444-4444-8444-aaaaaaaaaaa2"],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO booking.quote_sessions
           (
             id, property_id, request_hash, public_quote_reference,
             requested_check_in, requested_check_out, adults,
             children, requested_room_count, currency, expires_at
           )
         VALUES (
           $1, $2, 'sha256:distribution-test',
           'DIST-QUOTE-ONE', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'USD', now() + INTERVAL '15 minutes'
         )`,
        [distributionQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.checkout_contexts
           (id, quote_session_id, property_id, locale, currency, expires_at)
         VALUES ($1, $2, $3, 'en', 'USD', now() + INTERVAL '15 minutes')`,
        [distributionCheckoutContextId, distributionQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.quote_sessions
           (
             id, property_id, request_hash, public_quote_reference,
             requested_check_in, requested_check_out, adults,
             children, requested_room_count, currency, expires_at
           )
         VALUES (
           $1, $2, 'sha256:distribution-mismatch-test',
           'DIST-QUOTE-TWO', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'USD', now() + INTERVAL '15 minutes'
         )`,
        [distributionMismatchQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.checkout_contexts
           (id, quote_session_id, property_id, locale, currency, expires_at)
         VALUES ($1, $2, $3, 'en', 'USD', now() + INTERVAL '15 minutes')`,
        [
          distributionMismatchCheckoutContextId,
          distributionMismatchQuoteSessionId,
          distributionPropertyId,
        ],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_quote_read_models
           (
             quote_session_id, property_id, public_quote_reference,
             quote_hash, request_snapshot, quote_status,
             offers, totals, deep_link_url, currency,
             source_freshness, freshness_status, expires_at
           )
         VALUES (
           $1, $2, 'DIST-QUOTE-ONE', 'sha256:distribution-test',
           '{"checkIn":"2026-03-01","checkOut":"2026-03-03","adults":2,"rooms":1}'::jsonb,
           'bookable',
           '[{"offerId":"suite-flex","paymentOptions":["card","pay_at_property"]}]'::jsonb,
           '{"currency":"USD","grandTotal":440}'::jsonb,
           'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
           'USD',
           '{"sources":[{"owner":"booking","status":"fresh"},{"owner":"pms","status":"fresh"}]}'::jsonb,
           'fresh',
           now() + INTERVAL '15 minutes'
         )`,
        [distributionQuoteSessionId, distributionPropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE distribution.public_quote_read_models
           SET offers = $1::jsonb
           WHERE quote_session_id = $2`,
          [
            JSON.stringify([
              {
                offerId: "suite-flex",
                finance: { providerAccountId: "acct_private" },
              },
            ]),
            distributionQuoteSessionId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        verifyClient.query(
          `INSERT INTO distribution.booking_deep_link_contexts
             (
               property_id, quote_session_id, checkout_context_id,
               context_token_hash, deep_link_url, locale, currency,
               check_in, check_out, adults, children, rooms,
               expires_at
             )
           VALUES (
             $1, $2, $3, 'sha256:mismatched-deep-link',
             'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
             'en', 'USD', DATE '2026-03-01', DATE '2026-03-03',
             2, 0, 1, now() + INTERVAL '15 minutes'
           )`,
          [
            distributionPropertyId,
            distributionQuoteSessionId,
            distributionMismatchCheckoutContextId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO distribution.booking_deep_link_contexts
           (
             id, property_id, quote_session_id, checkout_context_id,
             public_quote_reference, context_token_hash, deep_link_url,
             locale, currency, check_in, check_out, adults,
             children, rooms, referral_code, request_context,
             source_freshness, expires_at
           )
         VALUES (
           $1, $2, $3, $4, 'DIST-QUOTE-ONE',
           'sha256:deep-link-context',
           'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
           'en', 'USD', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'creator-public',
           '{"preserves":["dates","guests","quote_id"]}'::jsonb,
           '{"sources":[{"owner":"distribution","status":"fresh"}]}'::jsonb,
           now() + INTERVAL '15 minutes'
         )`,
        [
          distributionDeepLinkContextId,
          distributionPropertyId,
          distributionQuoteSessionId,
          distributionCheckoutContextId,
        ],
      );

      await verifyClient.query(
        `INSERT INTO distribution.external_api_clients
           (
             id, public_client_id, client_name, contact_email,
             allowed_surfaces, rate_limit_tier, terms_version,
             credential_hash_ref, created_by_user_id, client_metadata
           )
         VALUES (
           $1, 'client_public_distribution_test',
           'Distribution Public Client',
           'partner@example.com',
           ARRAY['public_profile', 'public_quote']::TEXT[],
           'partner', 'public-bookability-v1',
           'sha256:credential-hash-ref',
           $2,
           '{"owner":"partner-success"}'::jsonb
         )`,
        [distributionClientId, distributionUserId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (public_client_id, client_name, rate_limit_tier, terms_version)
           VALUES (
             'client_public_distribution_test',
             'Duplicate Client', 'partner', 'public-bookability-v1'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (
               public_client_id, client_name, status, rate_limit_tier,
               terms_version, revoked_at
             )
           VALUES (
             'client_public_distribution_active_revoked',
             'Active But Revoked Client', 'active', 'partner',
             'public-bookability-v1', now()
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (public_client_id, client_name, rate_limit_tier, terms_version, client_metadata)
           VALUES (
             'client_public_distribution_bad_secret',
             'Bad Secret Client', 'partner', 'public-bookability-v1',
             '{"apiKey":"raw-key-should-not-live-here"}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO distribution.external_api_usage_events
           (
             client_id, property_id, quote_session_id, deep_link_context_id,
             surface, request_method, route_template, response_status,
             rate_limit_policy, rate_limit_tier, rate_limit_key_hash,
             request_fingerprint_hash, ip_address_hash, user_agent_hash,
             cache_status, latency_ms, usage_metadata
           )
         VALUES (
           $1, $2, $3, $4, 'public_quote', 'GET',
           '/api/ai/hotels/{slug}/quote', 200,
           'public-ai-quote-read', 'partner',
           'sha256:rate-limit-key', 'sha256:request-fingerprint',
           'sha256:ip-address', 'sha256:user-agent', 'miss', 42,
           '{"cacheKey":"public-quote"}'::jsonb
         )`,
        [
          distributionClientId,
          distributionPropertyId,
          distributionQuoteSessionId,
          distributionDeepLinkContextId,
        ],
      );
      await expect(
        verifyClient.query(`DELETE FROM distribution.external_api_clients WHERE id = $1`, [
          distributionClientId,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_usage_events
             (
               client_id, surface, request_method, route_template,
               response_status, rate_limit_policy, rate_limit_tier,
               usage_metadata
             )
           VALUES (
             $1, 'public_quote', 'GET', '/api/ai/hotels/{slug}/quote',
             200, 'public-ai-quote-read', 'partner',
             '{"requestBody":{"raw":"private request body"}}'::jsonb
           )`,
          [distributionClientId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await verifyClient.end();
    }
  });
});
