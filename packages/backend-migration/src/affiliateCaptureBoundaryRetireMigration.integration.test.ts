import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_affiliate_capture_retire_test";
const MIGRATION = 497;

// VAY-2272: the affiliate click capture guard leaves the shared tables; property_slugs keeps a
// permissive policy next to the restrictive pricing one, so other logins keep their access.
describe.skipIf(!URL)("affiliate capture boundary retirement 0497", () => {
  it("drops the guard objects and keeps slug access for logins that do not own the table", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-affiliate-capture-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    const role = `vay2272_slug_${randomUUID().slice(0, 8)}`;
    const password = randomUUID();
    let target: pg.Client | undefined;
    let login: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const property = randomUUID();
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Slug hotel')`,
        [property],
      );
      await db.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose)
         VALUES ($1::uuid, $2, 'canonical')`,
        [property, `slug-${property}`],
      );
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER`);
      await db.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${role}`);
      await db.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${role}`);
      await db.query(`GRANT SELECT, UPDATE ON hotel_catalog.property_slugs TO ${role}`);

      expect((await run(MIGRATIONS)).failed).toBeNull();

      const policies = await db.query<{ table: string; name: string; permissive: boolean }>(
        `SELECT polrelid::regclass::text AS table, polname AS name, polpermissive AS permissive
         FROM pg_catalog.pg_policy
         WHERE polrelid IN ('hotel_catalog.property_slugs'::regclass, 'hotel_catalog.properties'::regclass)
           AND (polname LIKE 'affiliate%' OR polname = 'property_slugs_existing_access')
         ORDER BY 1, 2`,
      );
      expect(policies.rows).toEqual([
        {
          table: "hotel_catalog.property_slugs",
          name: "property_slugs_existing_access",
          permissive: true,
        },
      ]);
      expect(
        (
          await db.query(
            `SELECT relrowsecurity FROM pg_catalog.pg_class
             WHERE oid = 'hotel_catalog.property_slugs'::regclass`,
          )
        ).rows,
      ).toEqual([{ relrowsecurity: true }]);
      expect(
        (
          await db.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'booking' AND table_name = 'guest_bookings'
               AND column_name = 'affiliate_binding_created_xid'
             UNION ALL
             SELECT tgname FROM pg_catalog.pg_trigger
             WHERE tgname = 'guest_bookings_affiliate_creation_xid_no_update'
             UNION ALL
             SELECT proname FROM pg_catalog.pg_proc
             WHERE proname IN ('reject_affiliate_booking_creation_xid_mutation',
               'bind_live_affiliate_original', 'admit_affiliate_click', 'capture_affiliate_click',
               'consume_affiliate_click_quota')`,
          )
        ).rows,
      ).toEqual([]);

      // A login that does not own the table still reads and updates slugs under the restrictive
      // pricing policy.
      const loginUrl = new globalThis.URL(targetUrl.href);
      loginUrl.username = role;
      loginUrl.password = password;
      login = new pg.Client({ connectionString: loginUrl.href });
      await login.connect();
      expect(
        (
          await login.query(
            `SELECT slug FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid`,
            [property],
          )
        ).rows,
      ).toEqual([{ slug: `slug-${property}` }]);
      expect(
        (
          await login.query(
            `UPDATE hotel_catalog.property_slugs SET updated_at = now() WHERE property_id = $1::uuid`,
            [property],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await login?.end();
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
