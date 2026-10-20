import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_marketplace_schema_drop_test";
const MIGRATION = 499;
const RUN_ID = `vay1351-${"e".repeat(24)}`;
const ACL_ROLE = "vayada_test_marketplace_default_acl";

const listAfter = (sql: string, keyword: string) =>
  sql
    .slice(sql.indexOf(keyword) + keyword.length)
    .split(/IN ACCESS EXCLUSIVE MODE|;/)[0]!
    .split(",")
    .map((name) => name.trim());

// VAY-2272: the marketplace schema goes; hotel data, commission rules and provenance stay.
describe.skipIf(!URL)("marketplace schema drop 0499", () => {
  it("drops the schema and the quarantine table and keeps what other products own", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-marketplace-schema-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${ACL_ROLE}`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      await admin.query(`CREATE ROLE ${ACL_ROLE} NOLOGIN`);
      let file = "";
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        if (Number(name.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, name), join(before, name));
        if (Number(name.slice(0, 4)) === MIGRATION) file = name;
      }
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      // The migration locks every table it drops and every table one of them references.
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      const dropped = listAfter(sql, "DROP TABLE");
      const referenced = await db.query<{ name: string }>(
        `SELECT DISTINCT target_namespace.nspname || '.' || target_table.relname AS name
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class source_table ON source_table.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
         JOIN pg_catalog.pg_class target_table ON target_table.oid = constraint_row.confrelid
         JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target_table.relnamespace
         WHERE constraint_row.contype = 'f'
           AND source_namespace.nspname || '.' || source_table.relname = ANY($1::text[])`,
        [dropped],
      );
      expect(listAfter(sql, "LOCK TABLE").sort()).toEqual(
        [...new Set([...dropped, ...referenced.rows.map((row) => row.name)])].sort(),
      );

      // Production gives the schema default privileges; DROP SCHEMA removes them with it.
      await db.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA marketplace GRANT SELECT ON TABLES TO ${ACL_ROLE}`,
      );

      const [owner, organization, property] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query(
        `INSERT INTO identity.users (id, email) VALUES ($1::uuid, 'hotel@example.test')`,
        [owner],
      );
      await db.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1::uuid, 'hotel_group', 'Schema drop hotel', $1::text)`,
        [organization],
      );
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Schema drop hotel')`,
        [property],
      );
      // A Marketplace hotel profile cascades from the property, never the other way round.
      await db.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles
           (property_id, organization_id, marketplace_profile_status, profile_complete)
         VALUES ($1, $2, 'verified', TRUE)`,
        [property, organization],
      );
      await db.query(
        `INSERT INTO marketplace.invite_codes (code, invite_type, property_id)
         VALUES ('VAY-SCHEMA-DROP', 'hotel', $1::uuid)`,
        [property],
      );
      await db.query(
        `INSERT INTO finance.commission_rules
           (property_id, rule_scope, product, commission_type, percentage_rate, starts_at,
            source_system, ota_channel, revision)
         VALUES ($1, 'property', 'pms', 'percentage', 15, '2026-01-01', 'finance', 'airbnb', 1)`,
        [property],
      );
      await db.query(
        `INSERT INTO platform.source_extraction_runs
           (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
         VALUES ($1, 'local', $2, 'completed', now(), 1)`,
        [RUN_ID, "f".repeat(40)],
      );
      await db.query(
        `INSERT INTO platform.production_migration_source_links
           (source_database, source_table, source_id, target_product, target_table, target_id,
            first_run_id, last_run_id, source_checksum)
         VALUES ('marketplace', 'hotel_profiles', '1', 'marketplace', 'marketplace_hotel_profiles',
                 $1, $2, $2, $3)`,
        [property, RUN_ID, "a".repeat(64)],
      );
      const kept = async () =>
        (
          await db.query(
            `SELECT
               (SELECT count(*)::int FROM hotel_catalog.properties WHERE id = $1) AS properties,
               (SELECT count(*)::int FROM hotel_catalog.hotel_account_invites WHERE property_id = $1) AS invites,
               (SELECT count(*)::int FROM finance.commission_rules WHERE property_id = $1) AS rules,
               (SELECT count(*)::int FROM platform.production_migration_source_links
                WHERE target_product = 'marketplace') AS provenance`,
            [property],
          )
        ).rows[0];
      expect(await kept()).toEqual({ properties: 1, invites: 1, rules: 1, provenance: 1 });
      const matchingCheck = async () =>
        (
          await db.query(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_constraint
             WHERE conrelid = 'platform.domain_events'::regclass
               AND conname = 'chk_platform_matching_event_private_payload'`,
          )
        ).rows[0].n;
      expect(await matchingCheck()).toBe(1);

      // Later migrations may change what this checks, so it stops at 0499.
      await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();

      expect(await kept()).toEqual({ properties: 1, invites: 1, rules: 1, provenance: 1 });
      // The Marketplace matching-event check (0142) went too.
      expect(await matchingCheck()).toBe(0);
      const leftovers = await db.query<{ name: string }>(
        `SELECT 'schema ' || nspname AS name FROM pg_catalog.pg_namespace WHERE nspname = 'marketplace'
         UNION ALL
         SELECT 'relation ' || relname FROM pg_catalog.pg_class
         WHERE relname LIKE '%marketplace%' AND relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         UNION ALL
         SELECT 'function ' || proname FROM pg_catalog.pg_proc
         WHERE proname = 'protect_production_marketplace_migration_quarantine'`,
      );
      expect(leftovers.rows).toEqual([]);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_default_acl acl, aclexplode(acl.defaclacl) entry
             WHERE entry.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`,
            [ACL_ROLE],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await db.query(
            `SELECT nspname FROM pg_catalog.pg_namespace
             WHERE nspname LIKE 'migration\\_source\\_%' ORDER BY 1`,
          )
        ).rows.map((row) => row.nspname),
      ).toEqual([
        "migration_source_auth",
        "migration_source_booking",
        "migration_source_marketplace",
        "migration_source_pms",
      ]);
      // Hotel invites stay writable in their own table.
      await db.query(
        `INSERT INTO hotel_catalog.hotel_account_invites (code, invite_type) VALUES ('VAY-AFTER-DROP', 'hotel')`,
      );
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${ACL_ROLE}`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
