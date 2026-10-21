import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_affiliate_capture_login_revoke_test";
const MIGRATION = 504;
// 0504 looks the login up by its production name.
const LOGIN = "vayada_next_affiliate_capture";
// A non-superuser that grants on objects it owns, as the production migration owner does.
const OWNER = "vayada_test_capture_grant_owner";
// Another grantor: 0504 cannot revoke its grants and leaves them to platform's inspect.
const OTHER = "vayada_test_capture_other_grantor";

// What the production migration owner granted the login (platform inspect, 2026-10-21): 31
// privileges, 13 of them on objects that 0498 and 0499 keep.
const PRODUCTION_GRANTS = [
  `GRANT SELECT, UPDATE ON booking.affiliate_destination_versions,
     booking.affiliate_referral_production_preflights, booking.affiliate_referral_transport_certifications,
     booking.affiliate_validation_probes, hotel_catalog.properties, hotel_catalog.property_slugs,
     marketplace.affiliate_agreement_activations, marketplace.affiliate_agreement_lifecycle_events,
     marketplace.affiliate_published_terms TO ${LOGIN}`,
  `GRANT SELECT ON booking.affiliate_referral_production_preflight_revocations,
     booking.affiliate_validation_probe_revocations, distribution.active_public_booking_revision,
     distribution.public_booking_content_revisions, hotel_catalog.property_domains,
     marketplace.affiliate_links TO ${LOGIN}`,
  `GRANT EXECUTE ON FUNCTION platform.channex_management_worker_scope(text, text, uuid),
     platform.finance_expense_worker_scope(text, text, uuid) TO ${LOGIN}`,
  `GRANT USAGE ON SCHEMA booking, distribution, hotel_catalog, marketplace, platform TO ${LOGIN}`,
];

type Granted = { kind: string; name: string; privilege: string; grantor: string };

// Every privilege the login holds in this database, with its grantor.
const granted = async (db: pg.Client) =>
  (
    await db.query<Granted>(
      `SELECT kind, name, privilege, pg_catalog.pg_get_userbyid(grantor) AS grantor FROM (
         SELECT 'relation' AS kind, c.oid::regclass::text AS name, acl.privilege_type AS privilege,
                acl.grantor, acl.grantee
         FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
         UNION ALL
         SELECT 'column', a.attrelid::regclass::text || '.' || a.attname, acl.privilege_type,
                acl.grantor, acl.grantee
         FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
         UNION ALL
         SELECT 'routine', p.oid::regprocedure::text, acl.privilege_type, acl.grantor, acl.grantee
         FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) acl
         UNION ALL
         SELECT 'schema', n.nspname::text, acl.privilege_type, acl.grantor, acl.grantee
         FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) acl
       ) privileges
       WHERE grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
       ORDER BY kind, name, privilege, grantor`,
      [LOGIN],
    )
  ).rows;

const OTHER_GRANTS: Granted[] = [
  { kind: "relation", name: "hotel_catalog.property_domains", privilege: "SELECT", grantor: OTHER },
  { kind: "relation", name: "vayada_test_capture_other.u", privilege: "SELECT", grantor: OTHER },
  { kind: "schema", name: "vayada_test_capture_other", privilege: "USAGE", grantor: OTHER },
];
const OWNER_GRANTS: Granted[] = [
  { kind: "column", name: "vayada_test_capture_owned.t.note", privilege: "UPDATE", grantor: OWNER },
  { kind: "relation", name: "vayada_test_capture_owned.s", privilege: "USAGE", grantor: OWNER },
  { kind: "relation", name: "vayada_test_capture_owned.t", privilege: "SELECT", grantor: OWNER },
  { kind: "routine", name: "vayada_test_capture_owned.f()", privilege: "EXECUTE", grantor: OWNER },
  { kind: "schema", name: "vayada_test_capture_owned", privilege: "USAGE", grantor: OWNER },
];
const sorted = (rows: Granted[]) =>
  [...rows].sort((a, b) =>
    [a.kind, a.name, a.privilege, a.grantor].join("|") <
    [b.kind, b.name, b.privilege, b.grantor].join("|")
      ? -1
      : 1,
  );

// VAY-2272: platform drops the login as vayada_admin only once no one else grants it anything, and
// only a grantor can revoke its grant, so 0504 revokes the migration owner's.
describe.skipIf(!URL)("affiliate capture login grants revoke 0504", () => {
  it("revokes what the migration owner granted the login, and only that", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-capture-login-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${LOGIN}, ${OWNER}, ${OTHER}`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      let file = "";
      const through: string[] = [];
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        const version = Number(name.slice(0, 4));
        // Up to 0497: the grants on what 0498 and 0499 drop exist too, as in production before W2.
        if (version < 498) await cp(join(MIGRATIONS, name), join(before, name));
        else if (version <= MIGRATION) through.push(name);
        if (version === MIGRATION) file = name;
      }
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;
      const me = (await db.query<{ name: string }>("SELECT current_user AS name")).rows[0]!.name;

      // Without the login the migration has nothing to revoke and succeeds.
      await db.query("BEGIN");
      await db.query(sql);
      await db.query("ROLLBACK");

      await db.query(`CREATE ROLE ${LOGIN} NOLOGIN`);
      await db.query(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER`);
      await db.query(`CREATE ROLE ${OTHER} NOLOGIN NOSUPERUSER`);
      await db.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ${OWNER}, ${OTHER}`);
      for (const statement of PRODUCTION_GRANTS) await db.query(statement);
      // A column privilege on a table the login has no table privilege on.
      await db.query(`GRANT SELECT (id) ON identity.users TO ${LOGIN}`);
      await db.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${OTHER}`);
      await db.query(
        `GRANT SELECT ON hotel_catalog.property_domains TO ${OTHER} WITH GRANT OPTION`,
      );
      await db.query(`SET ROLE ${OWNER}`);
      await db.query(`CREATE SCHEMA vayada_test_capture_owned`);
      await db.query(`CREATE TABLE vayada_test_capture_owned.t (id integer, note text)`);
      await db.query(`CREATE SEQUENCE vayada_test_capture_owned.s`);
      await db.query(
        `CREATE FUNCTION vayada_test_capture_owned.f() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      );
      await db.query(`GRANT USAGE ON SCHEMA vayada_test_capture_owned TO ${LOGIN}`);
      await db.query(`GRANT SELECT ON vayada_test_capture_owned.t TO ${LOGIN}`);
      await db.query(`GRANT UPDATE (note) ON vayada_test_capture_owned.t TO ${LOGIN}`);
      await db.query(`GRANT USAGE ON SEQUENCE vayada_test_capture_owned.s TO ${LOGIN}`);
      await db.query(`GRANT EXECUTE ON FUNCTION vayada_test_capture_owned.f() TO ${LOGIN}`);
      await db.query(`SET ROLE ${OTHER}`);
      await db.query(`CREATE SCHEMA vayada_test_capture_other`);
      await db.query(`CREATE TABLE vayada_test_capture_other.u (id integer)`);
      await db.query(`GRANT USAGE ON SCHEMA vayada_test_capture_other TO ${LOGIN}`);
      await db.query(`GRANT SELECT ON vayada_test_capture_other.u TO ${LOGIN}`);
      await db.query(`GRANT SELECT ON hotel_catalog.property_domains TO ${LOGIN}`);
      await db.query("RESET ROLE");

      const seeded = await granted(db);
      expect(seeded.filter((row) => row.grantor === me)).toHaveLength(32);
      expect(sorted(seeded.filter((row) => row.grantor !== me))).toEqual(
        sorted([...OWNER_GRANTS, ...OTHER_GRANTS]),
      );

      // 0498 and 0499 drop objects the login holds grants on, then 0504 runs as the owner of the
      // rest. Later migrations stay out.
      for (const name of through) await cp(join(MIGRATIONS, name), join(before, name));
      const result = await run(before);
      expect(result.failed).toBeNull();
      expect(result.applied.some((name) => name.includes("0504"))).toBe(true);
      expect(
        (await db.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'marketplace'"))
          .rowCount,
      ).toBe(0);
      expect(sorted(await granted(db))).toEqual(sorted([...OWNER_GRANTS, ...OTHER_GRANTS]));

      // The same SQL run by a non-superuser owner revokes its grants, a sequence and a column
      // privilege included.
      await db.query("BEGIN");
      await db.query(`SET LOCAL ROLE ${OWNER}`);
      await db.query(sql);
      await db.query("COMMIT");
      expect(sorted(await granted(db))).toEqual(sorted(OTHER_GRANTS));
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${LOGIN}, ${OWNER}, ${OTHER}`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
