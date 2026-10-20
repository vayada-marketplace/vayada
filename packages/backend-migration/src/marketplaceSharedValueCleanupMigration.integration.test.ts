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
const DATABASE = "vayada_marketplace_shared_value_cleanup_test";
const FINANCE_DATABASE = "vayada_affiliate_finance_value_cleanup_test";
const MIGRATION = 501;
const RETIRED_KEYS = [
  "affiliate.payout.manage",
  "marketplace.affiliate.manage",
  "marketplace.collaboration.read",
  "marketplace.collaboration.review",
  "marketplace.collaboration.write",
  "marketplace.finance.read",
  "marketplace.profile.manage",
  "marketplace.trip.manage",
  "marketplace.trip.read",
];

// Replica mode skips triggers and keys; checks still apply.
const replica = (sql: string) =>
  `BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`;
const handoff = (digit: string, source: string, target: string) =>
  `INSERT INTO identity.auth_session_handoffs
     (code_digest, source_surface, target_surface, source_public_origin, target_public_origin,
      sealed_session, target_path, expires_at)
   VALUES ('${digit.repeat(64)}', '${source}', '${target}', 'https://source.example',
           'https://target.example', 'sealed', '/next', now() + interval '1 hour')`;

// VAY-2272: 0501 removes the Marketplace and affiliate values that nothing writes any more.
describe.skipIf(!URL)("Marketplace shared value cleanup 0501", () => {
  it("stops on each gate, then removes the retired values and keeps what hotels use", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-shared-values-"));
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

      // One LOCK covers every table the migration alters or deletes from, and nothing else.
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      const changed = [...sql.matchAll(/^(?:ALTER TABLE|DELETE FROM) ([a-z_]+\.[a-z_]+)/gm)].map(
        (match) => match[1]!,
      );
      const locked = sql
        .slice(sql.indexOf("LOCK TABLE") + "LOCK TABLE".length)
        .split("IN ACCESS EXCLUSIVE MODE")[0]!
        .split(",")
        .map((name) => name.trim());
      expect(locked).toEqual([...new Set(changed)].sort());

      const organization = randomUUID();
      const property = randomUUID();
      const [canonical, redirect, overlay] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Cleanup hotel', $2)`,
        [organization, `cleanup-${organization}`],
      );
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Cleanup hotel')`,
        [property],
      );
      // A hotel's rows of every kind 0501 touches, a Marketplace overlay address and a handoff to
      // the retired Marketplace web app.
      await db.query(
        replica(`
          INSERT INTO hotel_catalog.property_slugs (id, property_id, slug, purpose, status, redirects_to_id)
          VALUES ('${canonical}', '${property}', 'cleanup-hotel', 'canonical', 'active', NULL),
                 ('${redirect}', '${property}', 'cleanup-hotel-old', 'redirect', 'redirected', '${canonical}'),
                 ('${overlay}', '${property}', 'cleanup-hotel-overlay', 'marketplace_overlay', 'active', NULL);
          INSERT INTO identity.organization_resource_links
            (organization_id, product, resource_type, resource_id, relationship)
          VALUES ('${organization}', 'booking', 'booking_hotel', '${property}', 'owner');
          INSERT INTO identity.product_entitlements
            (organization_id, product, entitlement_key, resource_product, resource_type, resource_id)
          VALUES ('${organization}', 'booking', 'booking-engine', 'booking', 'booking_hotel', '${property}');
          INSERT INTO finance.finance_visibility_read_model
            (organization_id, property_id, visibility_scope, resource_type, resource_id,
             required_permission_key, currency)
          VALUES ('${organization}', '${property}', 'property_finance', 'property', '${property}',
                  'pms.finance.read', 'EUR');
          ${handoff("a", "booking-admin", "pms-web")};
          ${handoff("b", "marketplace-web", "booking-admin")}`),
      );
      const state = async () => ({
        retiredKeys: (
          await db.query(
            `SELECT key FROM identity.permission_catalog WHERE key = ANY($1) ORDER BY key`,
            [RETIRED_KEYS],
          )
        ).rows.map((row) => row.key),
        handoffs: (
          await db.query(
            `SELECT source_surface || '>' || target_surface AS route
             FROM identity.auth_session_handoffs ORDER BY 1`,
          )
        ).rows.map((row) => row.route),
        slugs: (
          await db.query(`SELECT purpose FROM hotel_catalog.property_slugs ORDER BY 1`)
        ).rows.map((row) => row.purpose),
        rows: (
          await db.query(
            `SELECT (SELECT count(*) FROM identity.organization_resource_links)::int AS links,
                    (SELECT count(*) FROM identity.product_entitlements)::int AS entitlements,
                    (SELECT count(*) FROM finance.finance_visibility_read_model)::int AS visibility,
                    (SELECT count(*) FROM identity.role_permission_grants)::int AS grants,
                    (SELECT count(*) FROM identity.organization_roles)::int AS roles`,
          )
        ).rows[0],
        retiredConstraints: (
          await db.query(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_constraint
             WHERE conname IN ('uq_finance_commission_rules_id_organization',
                               'uq_finance_payouts_id_organization')`,
          )
        ).rows[0].n,
      });
      const seeded = await state();
      expect(seeded).toMatchObject({
        retiredKeys: RETIRED_KEYS,
        handoffs: ["booking-admin>pms-web", "marketplace-web>booking-admin"],
        slugs: ["canonical", "marketplace_overlay", "redirect"],
        rows: { links: 1, entitlements: 1, visibility: 1 },
        retiredConstraints: 2,
      });

      // Each gate stops 0501 before it changes anything. Later migrations may change what this
      // checks, so it applies only 0501.
      await cp(join(MIGRATIONS, file), join(before, file));
      const linkMessage = "A resource link still names a Marketplace or affiliate value";
      const gates: [string, string, string][] = [
        [
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship)
           VALUES ('${organization}', 'marketplace', 'hotel_profile', '${property}', 'owner')`,
          `DELETE FROM identity.organization_resource_links WHERE product = 'marketplace'`,
          linkMessage,
        ],
        [
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship)
           VALUES ('${organization}', 'booking', 'booking_hotel', '${property}', 'promotes')`,
          `DELETE FROM identity.organization_resource_links WHERE relationship = 'promotes'`,
          linkMessage,
        ],
        [
          `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key)
           VALUES ('${organization}', 'affiliate', 'affiliate-program')`,
          `DELETE FROM identity.product_entitlements WHERE product = 'affiliate'`,
          "A product entitlement still names a Marketplace or affiliate value",
        ],
        [
          `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, resource_product, resource_type, resource_id)
           VALUES ('${organization}', 'booking', 'creator-link', 'booking', 'creator_profile', 'gate-1')`,
          `DELETE FROM identity.product_entitlements WHERE resource_type = 'creator_profile'`,
          "A product entitlement still names a Marketplace or affiliate value",
        ],
        [
          `INSERT INTO finance.finance_visibility_read_model
             (organization_id, visibility_scope, resource_type, resource_id, required_permission_key,
              currency)
           VALUES ('${organization}', 'organization_finance', 'organization', '${organization}',
                   'marketplace.finance.read', 'EUR')`,
          `DELETE FROM finance.finance_visibility_read_model
           WHERE required_permission_key = 'marketplace.finance.read'`,
          "A finance visibility row still names a Marketplace or affiliate value",
        ],
        [
          `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
           VALUES ('hotel_group', 'hotel_owner', 'marketplace.trip.read')`,
          `DELETE FROM identity.role_permission_grants WHERE permission_key = 'marketplace.trip.read'`,
          "A role grant still names a creator or affiliate kind or a retired permission",
        ],
        [
          `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
           VALUES ('affiliate_partner', 'affiliate_owner', 'pms.read')`,
          `DELETE FROM identity.role_permission_grants WHERE organization_kind = 'affiliate_partner'`,
          "A role grant still names a creator or affiliate kind or a retired permission",
        ],
        [
          `INSERT INTO identity.organization_roles
             (organization_id, name, security_class, base_role_key, default_permissions)
           VALUES ('${organization}', 'Cleanup role', 'staff', 'hotel_custom',
                   '["pms.read", "marketplace.trip.read"]')`,
          `DELETE FROM identity.organization_roles WHERE name = 'Cleanup role'`,
          "A role preset still lists a retired permission",
        ],
        [
          `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status, redirects_to_id)
           VALUES ('${property}', 'cleanup-hotel-overlay-old', 'redirect', 'redirected', '${overlay}')`,
          `DELETE FROM hotel_catalog.property_slugs WHERE redirects_to_id = '${overlay}'`,
          "A page address redirects to a Marketplace overlay address",
        ],
      ];
      for (const [trip, undo, message] of gates) {
        await db.query(replica(trip));
        expect({ message, failed: (await run(before)).failed }).toEqual({
          message,
          failed: "0501",
        });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0501' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await db.query(replica(undo));
        expect({ message, state: await state() }).toEqual({ message, state: seeded });
      }

      expect((await run(before)).failed).toBeNull();

      // The retired values are gone; the hotel's rows stay.
      expect(await state()).toEqual({
        ...seeded,
        retiredKeys: [],
        handoffs: ["booking-admin>pms-web"],
        slugs: ["canonical", "redirect"],
        retiredConstraints: 0,
      });
      // The new checks refuse every retired value and still take the kept ones.
      const refused = [
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ('${organization}', 'marketplace', 'booking_hotel', 'refused-1', 'owner')`,
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ('${organization}', 'booking', 'creator_profile', 'refused-2', 'owner')`,
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ('${organization}', 'booking', 'booking_hotel', 'refused-3', 'promotes')`,
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ('${organization}', 'booking', 'hotel_profile', 'refused-6', 'owner')`,
        `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key)
         VALUES ('${organization}', 'marketplace', 'marketplace-listing')`,
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, resource_product, resource_type, resource_id)
         VALUES ('${organization}', 'booking', 'refused', 'affiliate', 'affiliate', 'refused-4')`,
        `INSERT INTO finance.finance_visibility_read_model
           (organization_id, visibility_scope, resource_type, resource_id, required_permission_key,
            currency)
         VALUES ('${organization}', 'affiliate_payout', 'affiliate', 'refused-5',
                 'platform.finance.read', 'EUR')`,
        `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
         VALUES ('creator_workspace', 'creator_owner', 'pms.read')`,
        `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
         VALUES ('affiliate_partner', 'affiliate_owner', 'pms.read')`,
        handoff("c", "marketplace-web", "booking-admin"),
        handoff("e", "booking-admin", "affiliate-dashboard"),
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose)
         VALUES ('${property}', 'refused-overlay', 'marketplace_overlay')`,
      ];
      for (const statement of refused) {
        await expect(db.query(replica(statement)), statement).rejects.toMatchObject({
          code: "23514",
        });
        // The failed statement leaves its transaction open and aborted.
        await db.query("ROLLBACK");
      }
      await db.query(
        replica(`
          INSERT INTO identity.organization_resource_links
            (organization_id, product, resource_type, resource_id, relationship)
          VALUES ('${organization}', 'pms', 'pms_hotel', 'kept-1', 'finance_manager');
          INSERT INTO finance.finance_visibility_read_model
            (organization_id, visibility_scope, resource_type, resource_id, required_permission_key,
             currency)
          VALUES ('${organization}', 'organization_finance', 'organization', '${organization}',
                  'platform.finance.read', 'EUR');
          ${handoff("d", "pms-web", "booking-admin")}`),
      );
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);

  // Flamur's yes to question 10: 0498 deleted the affiliate program's commission rules and billing
  // entitlements, so 0501 also removes their affiliate values.
  it("removes the affiliate values of commission rules and billing entitlements", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${FINANCE_DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-affiliate-finance-values-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${FINANCE_DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${FINANCE_DATABASE}`);
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

      const organization = randomUUID();
      const property = randomUUID();
      const hotelRule = randomUUID();
      await db.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Finance hotel', $2)`,
        [organization, `finance-${organization}`],
      );
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Finance hotel')`,
        [property],
      );
      // The hotel's commission rule, its rate change and its billing entitlement.
      await db.query(
        replica(`
          INSERT INTO finance.commission_rules
            (id, property_id, organization_id, rule_scope, product, commission_type, percentage_rate,
             source_system, source_rule_id)
          VALUES ('${hotelRule}', '${property}', '${organization}', 'property', 'booking', 'percentage',
                  5, 'finance', 'onboarding-booking:${property}');
          INSERT INTO finance.commission_rate_changes
            (commission_rule_id, previous_percentage_rate, new_percentage_rate, effective_at)
          VALUES ('${hotelRule}', 4, 5, now());
          INSERT INTO finance.billing_entitlements
            (organization_id, property_id, product, entitlement_key)
          VALUES ('${organization}', '${property}', 'booking', 'direct-booking-finance')`),
      );
      const state = async () =>
        (
          await db.query(
            `SELECT (SELECT array_agg(id::text || ':' || product || ':' || rule_scope ORDER BY id)
                     FROM finance.commission_rules) AS rules,
                    (SELECT count(*)::int FROM finance.commission_rate_changes) AS "rateChanges",
                    (SELECT array_agg(product ORDER BY product) FROM finance.billing_entitlements) AS billing,
                    (SELECT count(*)::int FROM pg_catalog.pg_attribute
                     WHERE attrelid = 'finance.commission_rules'::regclass
                       AND attname = 'affiliate_id' AND NOT attisdropped) AS "affiliateColumn",
                    (SELECT count(*)::int FROM pg_catalog.pg_indexes
                     WHERE schemaname = 'finance' AND indexname LIKE '%affiliate%') AS "affiliateIndexes"`,
          )
        ).rows[0];
      const seeded = await state();
      expect(seeded).toEqual({
        rules: [`${hotelRule}:booking:property`],
        rateChanges: 1,
        billing: ["booking"],
        affiliateColumn: 1,
        affiliateIndexes: 2,
      });

      // An affiliate product, scope or affiliate_id on a rule, an affiliate billing entitlement, or a
      // trigger function that reads the column each stops 0501 before it changes anything.
      await cp(join(MIGRATIONS, file), join(before, file));
      const rowMessage = "An affiliate commission rule or billing entitlement remains";
      const gates: [string, string, string][] = [
        [
          `INSERT INTO finance.commission_rules
             (property_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${property}', 'property', 'affiliate', 'percentage', 10)`,
          `DELETE FROM finance.commission_rules WHERE product = 'affiliate'`,
          rowMessage,
        ],
        [
          `INSERT INTO finance.commission_rules
             (organization_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${organization}', 'affiliate', 'booking', 'percentage', 10)`,
          `DELETE FROM finance.commission_rules WHERE rule_scope = 'affiliate'`,
          rowMessage,
        ],
        [
          `INSERT INTO finance.commission_rules
             (organization_id, rule_scope, product, commission_type, percentage_rate, affiliate_id)
           VALUES ('${organization}', 'organization', 'booking', 'percentage', 10, 'gate-affiliate')`,
          `DELETE FROM finance.commission_rules WHERE affiliate_id IS NOT NULL`,
          rowMessage,
        ],
        [
          `INSERT INTO finance.billing_entitlements (organization_id, product, entitlement_key)
           VALUES ('${organization}', 'affiliate', 'affiliate-program')`,
          `DELETE FROM finance.billing_entitlements WHERE product = 'affiliate'`,
          rowMessage,
        ],
        [
          `CREATE FUNCTION public.affiliate_rule_guard() RETURNS trigger LANGUAGE plpgsql
             AS 'BEGIN IF NEW.affiliate_id IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END';
           CREATE TRIGGER affiliate_rule_guard BEFORE INSERT ON finance.commission_rules
             FOR EACH ROW EXECUTE FUNCTION public.affiliate_rule_guard()`,
          `DROP TRIGGER affiliate_rule_guard ON finance.commission_rules;
           DROP FUNCTION public.affiliate_rule_guard()`,
          "A function still names affiliate_id",
        ],
      ];
      for (const [trip, undo, message] of gates) {
        await db.query(replica(trip));
        expect({ trip, failed: (await run(before)).failed }).toEqual({ trip, failed: "0501" });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0501' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await db.query(replica(undo));
        expect({ trip, state: await state() }).toEqual({ trip, state: seeded });
      }

      expect((await run(before)).failed).toBeNull();

      // The column and both indexes are gone; the hotel's rows stay.
      expect(await state()).toEqual({ ...seeded, affiliateColumn: 0, affiliateIndexes: 0 });
      // The four replaced checks are back, without the affiliate values.
      const checks = (
        await db.query<{ name: string; definition: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
           FROM pg_catalog.pg_constraint
           WHERE conrelid IN ('finance.commission_rules'::regclass, 'finance.billing_entitlements'::regclass)
             AND conname IN ('billing_entitlements_product_check', 'chk_finance_commission_rules_scope',
                             'commission_rules_product_check', 'commission_rules_rule_scope_check')
           ORDER BY conname`,
        )
      ).rows;
      expect(checks.map((check) => check.name)).toEqual([
        "billing_entitlements_product_check",
        "chk_finance_commission_rules_scope",
        "commission_rules_product_check",
        "commission_rules_rule_scope_check",
      ]);
      for (const check of checks) expect(check.definition, check.name).not.toMatch(/affiliate/);
      // PostgreSQL tests checks in name order, so the scope check refuses an affiliate scope first.
      const refused: [string, string][] = [
        [
          `INSERT INTO finance.commission_rules
             (property_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${property}', 'property', 'affiliate', 'percentage', 10)`,
          "commission_rules_product_check",
        ],
        [
          `INSERT INTO finance.commission_rules
             (organization_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${organization}', 'affiliate', 'booking', 'percentage', 10)`,
          "chk_finance_commission_rules_scope",
        ],
        // The rewritten scope check still requires the property of a property rule.
        [
          `INSERT INTO finance.commission_rules
             (organization_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${organization}', 'property', 'booking', 'percentage', 10)`,
          "chk_finance_commission_rules_scope",
        ],
        [
          `INSERT INTO finance.billing_entitlements (organization_id, product, entitlement_key)
           VALUES ('${organization}', 'affiliate', 'refused')`,
          "billing_entitlements_product_check",
        ],
      ];
      for (const [statement, constraint] of refused) {
        await expect(db.query(replica(statement)), statement).rejects.toMatchObject({
          code: "23514",
          constraint,
        });
        // The failed statement leaves its transaction open and aborted.
        await db.query("ROLLBACK");
      }
      // The Marketplace values of kept finance rows stay allowed.
      await db.query(
        replica(`
          INSERT INTO finance.commission_rules
            (organization_id, rule_scope, product, commission_type, percentage_rate)
          VALUES ('${organization}', 'marketplace', 'marketplace', 'percentage', 10);
          INSERT INTO finance.billing_entitlements (organization_id, product, entitlement_key)
          VALUES ('${organization}', 'marketplace', 'marketplace-listing')`),
      );
    } finally {
      await target?.end();
      await admin
        .query(`DROP DATABASE IF EXISTS ${FINANCE_DATABASE} WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
