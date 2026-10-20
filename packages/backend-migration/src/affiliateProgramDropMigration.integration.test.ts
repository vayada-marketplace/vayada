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
const DATABASE = "vayada_affiliate_program_drop_test";
const MIGRATION = 498;
const RUN_ID = `vay1351-${"a".repeat(24)}`;

const listAfter = (sql: string, keyword: string) =>
  sql
    .slice(sql.indexOf(keyword) + keyword.length)
    .split(/IN ACCESS EXCLUSIVE MODE|;/)[0]!
    .split(",")
    .map((name) => name.trim());

// VAY-2272: the affiliate program goes, money records included (decision 2: delete everything).
describe.skipIf(!URL)("affiliate program drop 0498", () => {
  it("drops the whole program with its rows and accepts retired finance dispositions", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-affiliate-program-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
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

      // One LOCK covers the dropped tables, every table they reference and the dispositions table,
      // and nothing else.
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
        [
          ...new Set([
            ...dropped,
            ...referenced.rows.map((row) => row.name),
            "platform.production_finance_migration_dispositions",
          ]),
        ].sort(),
      );

      const user = randomUUID();
      const organization = randomUUID();
      const property = randomUUID();
      await db.query(`INSERT INTO identity.users (id, email, status) VALUES ($1, $2, 'active')`, [
        user,
        `affiliate-journal-${user}@example.test`,
      ]);
      await db.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Journal hotel', $2)`,
        [organization, `journal-${organization}`],
      );
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Journal hotel')`,
        [property],
      );
      // Production holds money rows; the drop takes them along.
      await db.query(
        `INSERT INTO finance.affiliate_earning_journal
           (id, property_id, booking_id, stay_item_id, revision, source_revision, input_digest,
            calculation_input, outcome, actor_user_id, organization_id, request_id)
         VALUES ($1, $2, 'booking-1', 'stay-1', 1, 1, $3, '{}', '{"status": "calculated"}', $4, $5,
                 'request-1')`,
        [randomUUID(), property, "b".repeat(64), user, organization],
      );
      await db.query(
        `INSERT INTO platform.source_extraction_runs
           (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
         VALUES ($1, 'local', $2, 'completed', now(), 1)`,
        [RUN_ID, "c".repeat(40)],
      );
      const retiredDisposition = (sourceId: string) =>
        db.query(
          `INSERT INTO platform.production_finance_migration_dispositions
             (source_run_id, source_database, source_table, source_id, source_field,
              source_value_sha256, reason_code, disposition)
           VALUES ($1, 'pms', 'payouts', $2, '*', $3, 'RETIRED_AFFILIATE_PROGRAM', 'omitted_row')`,
          [RUN_ID, sourceId, "d".repeat(64)],
        );
      await expect(retiredDisposition("payout-before")).rejects.toMatchObject({ code: "23514" });

      // Later migrations may change what this checks, so it stops at 0498.
      await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();

      const relations = await db.query<{ name: string }>(
        `SELECT n.nspname || '.' || c.relname AS name
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND c.relname LIKE '%affiliate%'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         ORDER BY 1`,
      );
      expect(relations.rows.map((row) => row.name)).toEqual([]);
      const functions = await db.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('marketplace', 'booking', 'finance')
           AND (p.proname LIKE '%affiliate%' OR p.proname LIKE 'reject\\_synthetic\\_%')
         ORDER BY 1`,
      );
      expect(functions.rows.map((row) => row.name)).toEqual([]);
      // Only the two commission rule indexes carry the name.
      const indexes = await db.query<{ name: string }>(
        `SELECT tablename || '.' || indexname AS name FROM pg_catalog.pg_indexes
         WHERE schemaname = 'finance' AND indexname LIKE '%affiliate%'
         ORDER BY 1`,
      );
      expect(indexes.rows.map((row) => row.name)).toEqual([
        "commission_rules.uq_finance_active_property_affiliate_default",
        "commission_rules.uq_finance_active_property_affiliate_override",
      ]);
      await retiredDisposition("payout-after");
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM platform.production_finance_migration_dispositions
             WHERE reason_code = 'RETIRED_AFFILIATE_PROGRAM'`,
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
