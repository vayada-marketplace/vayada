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

// VAY-2272: the affiliate program goes, money records included (decision 2: delete everything),
// with its rows in the shared finance tables.
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
      const payee = randomUUID();
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
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'affiliate_partner', 'Affiliate payee', $2)`,
        [payee, `payee-${payee}`],
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
      // A recorded affiliate payment as production has one: the payout to the affiliate, the evidence
      // and its item, the idempotency key and the audit event that names it. Next to it the program's
      // other shared rows (a payout marked only by affiliate_id, a link key, a billing entitlement, a
      // commission rule with a rate change) and a hotel's rows of the same kinds, which stay. Replica
      // mode skips the evidence's aggregate triggers; checks apply.
      const [payout, key, evidence, linkKey, hotelKey] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const [hotelPayout, snakePayout, affiliateRule, hotelRule] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await db.query(
        `BEGIN; SET LOCAL session_replication_role = replica;
         INSERT INTO finance.payouts
           (id, owner_scope, organization_id, source_system, payout_status, amount, net_amount, currency,
            payout_metadata)
           VALUES ('${payout}', 'organization', '${payee}', 'finance', 'paid', 100, 100, 'EUR',
                   '{"affiliateId": "affiliate-1"}'),
                  ('${hotelPayout}', 'organization', '${organization}', 'finance', 'paid', 50, 50, 'EUR',
                   '{}'),
                  ('${snakePayout}', 'organization', '${organization}', 'finance', 'paid', 20, 20, 'EUR',
                   '{"affiliate_id": "affiliate-2"}');
         INSERT INTO platform.idempotency_keys
           (id, operation_scope, operation, key_hash, request_fingerprint_hash, status, tenant_scope,
            expires_at)
           VALUES ('${key}', 'finance', 'affiliate_payout_mark_paid', 'key-1', 'request-1', 'in_progress',
                   'platform', now() + interval '1 day'),
                  ('${linkKey}', 'marketplace', 'marketplace.affiliate_link.create', 'key-2', 'request-2',
                   'in_progress', 'platform', now() + interval '1 day'),
                  ('${hotelKey}', 'finance', 'finance.payout.dispatch', 'key-3', 'request-3', 'in_progress',
                   'platform', now() + interval '1 day');
         INSERT INTO platform.product_audit_events
           (audit_key, product, action, occurred_at, tenant_scope, actor_type, target_resource_product,
            target_resource_type, target_resource_id, idempotency_key_id, retention_class, privacy_scope)
           VALUES ('audit-1', 'finance', 'finance.affiliate_payout.marked_paid', now(), 'platform', 'system',
                   'finance', 'affiliate', 'affiliate-1', '${key}', 'financial', 'confidential');
         INSERT INTO finance.affiliate_payout_payment_evidence
           (id, organization_id, affiliate_id, recorded_by_organization_id, recorded_by_user_id,
            idempotency_key_id, command_id, request_fingerprint_hash, payment_method, external_reference,
            evidence_reference, amount, currency, payout_count, paid_at, recorded_at)
           VALUES ('${evidence}', '${payee}', 'affiliate-1', '${organization}', '${user}', '${key}',
                   'command-1', 'request-1', 'manual', 'reference-1', 'evidence-1', 100, 'EUR', 1, now(),
                   now());
         INSERT INTO finance.affiliate_payout_payment_evidence_items
           (evidence_id, organization_id, payout_id, amount, currency)
           VALUES ('${evidence}', '${payee}', '${payout}', 100, 'EUR');
         INSERT INTO finance.billing_entitlements (organization_id, product, entitlement_key)
           VALUES ('${payee}', 'affiliate', 'affiliate-program'), ('${organization}', 'pms', 'pms-plan');
         INSERT INTO finance.commission_rules
           (id, organization_id, property_id, rule_scope, product, commission_type, percentage_rate)
           VALUES ('${affiliateRule}', '${payee}', NULL, 'affiliate', 'affiliate', 'percentage', 10),
                  ('${hotelRule}', NULL, '${property}', 'property', 'booking', 'percentage', 15);
         INSERT INTO finance.commission_rate_changes
           (commission_rule_id, previous_percentage_rate, new_percentage_rate, effective_at)
           VALUES ('${affiliateRule}', 8, 10, now()), ('${hotelRule}', 12, 15, now());
         COMMIT`,
      );
      const left = async () => ({
        affiliateTables: (
          await db.query(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND c.relname LIKE '%affiliate%'
               AND c.relkind = 'r'`,
          )
        ).rows[0].n,
        payouts: (await db.query(`SELECT id FROM finance.payouts ORDER BY id`)).rows.map(
          (r) => r.id,
        ),
        keys: (
          await db.query(`SELECT operation FROM platform.idempotency_keys ORDER BY 1`)
        ).rows.map((r) => r.operation),
        billing: (
          await db.query(`SELECT product FROM finance.billing_entitlements ORDER BY 1`)
        ).rows.map((r) => r.product),
        rules: (await db.query(`SELECT id FROM finance.commission_rules ORDER BY id`)).rows.map(
          (r) => r.id,
        ),
        rateChanges: (
          await db.query(
            `SELECT commission_rule_id AS id FROM finance.commission_rate_changes ORDER BY 1`,
          )
        ).rows.map((r) => r.id),
      });
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

      // Later migrations may change what this checks, so it stops at 0498. Each gate stops it first
      // and changes nothing.
      await cp(join(MIGRATIONS, file), join(before, file));
      const seeded = await left();
      const gates: [string, string, string][] = [
        [
          `UPDATE finance.payouts SET payout_status = 'processing' WHERE id = '${payout}'`,
          `UPDATE finance.payouts SET payout_status = 'paid' WHERE id = '${payout}'`,
          "Affiliate payouts still in flight",
        ],
        [
          `BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO finance.ota_commission_evidence
             (booking_revenue_evidence_id, property_id, guest_booking_id, service_night, channel, currency,
              gross_room_amount, commission_rule_id, commission_rule_revision, percentage_rate,
              commission_amount, evidence_state)
             VALUES (gen_random_uuid(), '${property}', gen_random_uuid(), current_date, 'airbnb', 'EUR', 100,
                     '${affiliateRule}', 1, 10, 10, 'applied');
           COMMIT`,
          `BEGIN; SET LOCAL session_replication_role = replica;
           DELETE FROM finance.ota_commission_evidence; COMMIT`,
          "OTA commission evidence uses an affiliate commission rule",
        ],
      ];
      for (const [trip, undo, message] of gates) {
        await db.query(trip);
        expect({ message, failed: (await run(before)).failed }).toEqual({
          message,
          failed: "0498",
        });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0498' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await db.query(undo);
        expect({ message, left: await left() }).toEqual({ message, left: seeded });
      }
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
      // The program's shared rows are gone and the hotel's stay. Idempotency keys stay (the payment's
      // audit event names its key); nothing holds the user who recorded the payment any more.
      expect(await left()).toEqual({
        affiliateTables: 0,
        payouts: [hotelPayout],
        keys: [
          "affiliate_payout_mark_paid",
          "finance.payout.dispatch",
          "marketplace.affiliate_link.create",
        ],
        billing: ["pms"],
        rules: [hotelRule],
        rateChanges: [hotelRule],
      });
      await db.query(`DELETE FROM identity.users WHERE id = $1`, [user]);
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
