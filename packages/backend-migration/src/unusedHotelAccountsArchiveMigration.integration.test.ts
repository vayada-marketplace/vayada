import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_unused_hotel_accounts_test";
const MIGRATION = 555;

const id = (n: number) => `55500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const leftover = (block: number, n: number | string) =>
  `('55500000-0000-4000-800${block}-' || lpad((${n})::text, 12, '0'))::uuid`;

// The 22 accounts named on Flamur's list, as in the migration.
const NAMED = [
  "org_01KZ15CS16ZTJ3B8NKWFNNZ04A",
  "org_01KZ9D0RJZW05H8JFA3C72Q6ZT",
  "org_01KZ9D1BM6DPM0967CY6H61S4E",
  "org_01KZ9G9EDS1WF1VP5HN9GAC00T",
  "org_01KZB2QVF4S8CTQYKP9VR1E7JJ",
  "org_01KZR21HWKHVH4AEHH9R9C43S1",
  "org_01KZY0NRS02AWVW0MHPVRYEBMK",
  "org_01M0VMK95VEHRWT93QGG1ADX7X",
  "org_01M0VSN2C297BZRE9KBJ32YJCM",
  "org_01M18DDHE49CX9B1VYV57Z0VA0",
  "org_01M18N6QVSYM6JBXECP1S843A9",
  "org_01M1R50D1NXW3C2T2VZBNPQB77",
  "org_01M1T7YCNDSPFY8HDZMXM83D9T",
  "org_01M45FDVM6RBJ3YDR82F4ZQP08",
  "org_01M4BDA0G69A23QZ7EV6G2PTAQ",
  "org_01M4BDCP8QA3YX7C121F9CNSPS",
  "org_01M4H88YWW1F1W1TCYSRHGY3ND",
  "org_01KZQPR9FWP6Q4WAKQR8D0MN52",
  "org_01KZY2QXGPX8PPDXZAHWG0ATBA",
  "org_01KZY9HV858JJS6NG89Y1HC3HW",
  "org_01M5EYG361MJS6T0AQH4RA64XN",
  "org_01M6Q2VNAACPQADPC4F6V85WFB", // Timo's Depadma account
];
const CODEXQA = 19; // index in NAMED: keeps its Stripe test account
const TESTE1234 = 20; // index in NAMED: its booking page is published

const PLATFORM = id(1);
const STAFF = id(2);
const TIGA = id(10); // kept real hotel on the WorkOS list
const TIGA_HOTEL = id(11);
const OUTSIDE_SIGNUP = id(12); // kept (decision 106), its page stays published
const OUTSIDE_SIGNUP_HOTEL = id(13);
const SEPTEMBER = id(16); // outside WorkOS, created in September: not on the list
const SEPTEMBER_HOTEL = id(17);
const CLOSED = id(18); // outside WorkOS, created in August, already archived: left as it is
const CLOSED_HOTEL = id(19);
const KEPT_AUGUST = id(20); // kept, created in August, on the WorkOS list: not a leftover
const KEPT_AUGUST_HOTEL = id(21);
const named = (i: number) => id(100 + i);
const namedHotel = (i: number) => id(200 + i);

const SEED = `
  INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id, created_at) VALUES
    ('${PLATFORM}', 'platform', 'Vayada Platform', 'vay2602-platform', 'active', 'org_01M0YF1WF2TNNA6MMX2ZBYHMSY', '2026-08-26'),
    ('${TIGA}', 'hotel_group', 'Tiga', 'vay2602-tiga', 'active', 'org_01M6A933D9RY1PYH4ZD7XA58K1', '2026-11-01'),
    ('${OUTSIDE_SIGNUP}', 'hotel_group', 'Outside sign-up', 'vay2602-outside', 'active', 'org_01M6DGVQAEHW5PVH2QH6DABVAJ', '2026-11-02'),
    ('${SEPTEMBER}', 'hotel_group', 'September', 'vay2602-september', 'active', 'org_vay2602_september', '2026-09-10'),
    ('${CLOSED}', 'hotel_group', 'Closed smoke', 'vay2602-closed', 'archived', 'org_vay2602_closed', '2026-08-20'),
    ('${KEPT_AUGUST}', 'hotel_group', 'Kept August', 'vay2602-kept-august', 'active', 'org_01KZQQ019EF052PFARPCG7B613', '2026-08-11');
  INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id, created_at)
  SELECT ('55500000-0000-4000-8000-' || lpad((100 + n - 1)::text, 12, '0'))::uuid, 'hotel_group',
         'Named ' || n, 'vay2602-named-' || n, 'active', (ARRAY['${NAMED.join("','")}'])[n],
         '2026-08-05'::timestamptz + n * interval '3 days'
  FROM generate_series(1, 22) n;
  -- The 70 August leftovers: WorkOS no longer knows them.
  INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id, created_at)
  SELECT ${leftover(1, "n")}, 'hotel_group', 'QA Next ' || n, 'vay2602-leftover-' || n, 'active',
         'org_vay2602_gone_' || n, '2026-08-01T00:00:00Z'::timestamptz + n * interval '10 hours'
  FROM generate_series(1, 70) n;

  INSERT INTO identity.users (id, email, name, status) VALUES ('${STAFF}', 'vay2602-staff@example.test', 'Staff', 'active');
  INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
  VALUES ('${STAFF}', 'workos', 'user_01KZQPZ02TKJJF9TPTBXG3NXPP');
  INSERT INTO identity.organization_memberships
    (organization_id, user_id, role_key, status, access_origin, property_access_mode)
  VALUES ('${PLATFORM}', '${STAFF}', 'platform_admin', 'active', 'agency', 'all');

  INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES
    ('${TIGA_HOTEL}', 'vay2602-tiga', 'Tiga'),
    ('${OUTSIDE_SIGNUP_HOTEL}', 'vay2602-outside', 'Outside'),
    ('${SEPTEMBER_HOTEL}', 'vay2602-september', 'September'),
    ('${CLOSED_HOTEL}', 'vay2602-closed', 'Closed'),
    ('${KEPT_AUGUST_HOTEL}', 'vay2602-kept-august', 'Kept August');
  INSERT INTO hotel_catalog.properties (id, public_id, display_name)
  SELECT ('55500000-0000-4000-8000-' || lpad((200 + n - 1)::text, 12, '0'))::uuid, 'vay2602-named-' || n, 'Named ' || n
  FROM generate_series(1, 22) n WHERE n NOT IN (3, 6, 9, 12, 15);
  INSERT INTO hotel_catalog.properties (id, public_id, display_name)
  SELECT ${leftover(2, "n")}, 'vay2602-leftover-' || n, 'QA Next Hotel ' || n FROM generate_series(1, 60) n;
  -- One leftover hotel was retired already.
  UPDATE hotel_catalog.properties
  SET lifecycle_status = 'retired', profile_status = 'disabled', retired_at = '2026-09-01', retired_by_user_id = '${STAFF}'
  WHERE id = ${leftover(2, 1)};

  INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES
    ('${TIGA}', 'hotel_catalog', 'property', '${TIGA_HOTEL}', 'owner', 'active'),
    ('${OUTSIDE_SIGNUP}', 'hotel_catalog', 'property', '${OUTSIDE_SIGNUP_HOTEL}', 'owner', 'active'),
    ('${SEPTEMBER}', 'hotel_catalog', 'property', '${SEPTEMBER_HOTEL}', 'owner', 'active'),
    ('${CLOSED}', 'hotel_catalog', 'property', '${CLOSED_HOTEL}', 'owner', 'active'),
    ('${KEPT_AUGUST}', 'hotel_catalog', 'property', '${KEPT_AUGUST_HOTEL}', 'owner', 'active');
  INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status)
  SELECT ('55500000-0000-4000-8000-' || lpad((100 + n - 1)::text, 12, '0'))::uuid, 'hotel_catalog', 'property',
         ('55500000-0000-4000-8000-' || lpad((200 + n - 1)::text, 12, '0')), 'owner', 'active'
  FROM generate_series(1, 22) n WHERE n NOT IN (3, 6, 9, 12, 15);
  -- Half the leftover hotels are held through a PMS link only.
  INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status)
  SELECT ${leftover(1, "n")},
         CASE WHEN n % 2 = 0 THEN 'pms' ELSE 'hotel_catalog' END,
         CASE WHEN n % 2 = 0 THEN 'pms_property' ELSE 'property' END,
         (${leftover(2, "n")})::text, 'owner', 'active'
  FROM generate_series(1, 60) n;

  -- Stays and money: a past test booking (no blocker) and Codexqa's Stripe test account (kept).
  INSERT INTO booking.guest_bookings (property_id, public_reference, lifecycle_status, check_in, check_out, currency)
  VALUES (${leftover(2, 2)}, 'VAY2602-PAST', 'confirmed', '2026-08-18', '2026-08-20', 'EUR'),
         ('${TIGA_HOTEL}', 'VAY2602-TIGA', 'confirmed', current_date + 5, current_date + 7, 'EUR');
  INSERT INTO pms.channel_connections (property_id, provider, connection_status)
  VALUES ('${TIGA_HOTEL}', 'channex', 'connected');
  INSERT INTO finance.payment_provider_accounts (account_scope, property_id, provider, provider_account_id)
  VALUES ('property', '${namedHotel(CODEXQA)}', 'stripe', 'acct_vay2602_codexqa');

  -- Published booking pages: Teste1234's goes, the kept outside sign-up's stays.
  INSERT INTO distribution.active_public_booking_revision (property_id, content_revision_id, activated_by_user_id) VALUES
    ('${namedHotel(TESTE1234)}', '${id(300)}', '${STAFF}'),
    ('${OUTSIDE_SIGNUP_HOTEL}', '${id(301)}', '${STAFF}');
  INSERT INTO distribution.public_hotel_bookability_profiles
    (property_id, public_id, canonical_slug, canonical_url, booking_base_url, timezone, default_currency,
     supported_currencies, profile_status, freshness_status) VALUES
    ('${namedHotel(TESTE1234)}', 'vay2602-named-21', 'teste1234', 'https://teste1234.example.test', 'https://example.test',
     'Asia/Makassar', 'EUR', '{EUR}', 'public', 'fresh'),
    ('${OUTSIDE_SIGNUP_HOTEL}', 'vay2602-outside', 'outside', 'https://outside.example.test', 'https://example.test',
     'Asia/Makassar', 'EUR', '{EUR}', 'public', 'fresh');
`;

const APPROVED_HOTEL = namedHotel(0);
const LEFTOVER_HOTEL = `${leftover(2, 3)}`;
// [label, trip, undo, failure reason]
const GATES: Array<[string, string, string, string]> = [
  [
    "one more August leftover",
    `INSERT INTO identity.organizations (id, kind, name, slug, status, workos_org_id, created_at)
     VALUES ('${id(500)}', 'hotel_group', 'QA Next 71', 'vay2602-leftover-71', 'active', 'org_vay2602_gone_71', '2026-08-31T12:00:00Z')`,
    `DELETE FROM identity.organizations WHERE id = '${id(500)}'`,
    "VAY-2602: more than the 70 August leftovers match",
  ],
  [
    "a named account is suspended",
    `UPDATE identity.organizations SET status = 'suspended' WHERE id = '${named(0)}'`,
    `UPDATE identity.organizations SET status = 'active' WHERE id = '${named(0)}'`,
    "VAY-2602: a named account is not an active or archived hotel account",
  ],
  [
    "the staff login left the platform",
    `UPDATE identity.organization_memberships SET status = 'inactive' WHERE user_id = '${STAFF}'`,
    `UPDATE identity.organization_memberships SET status = 'active' WHERE user_id = '${STAFF}'`,
    "VAY-2602: the Vayada staff login is not one active platform member",
  ],
  [
    "a kept account holds an approved hotel too",
    `INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ('${TIGA}', 'pms', 'pms_property', (${LEFTOVER_HOTEL})::text, 'operator', 'active')`,
    `DELETE FROM identity.organization_resource_links WHERE organization_id = '${TIGA}' AND resource_id = (${LEFTOVER_HOTEL})::text`,
    "VAY-2602: a hotel is shared with an account that stays",
  ],
  [
    "a suspended account holds an approved hotel too",
    `UPDATE identity.organizations SET status = 'suspended' WHERE id = '${SEPTEMBER}';
     INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ('${SEPTEMBER}', 'hotel_catalog', 'property', (${LEFTOVER_HOTEL})::text, 'owner', 'active')`,
    `DELETE FROM identity.organization_resource_links WHERE organization_id = '${SEPTEMBER}' AND resource_id = (${LEFTOVER_HOTEL})::text;
     UPDATE identity.organizations SET status = 'active' WHERE id = '${SEPTEMBER}'`,
    "VAY-2602: a hotel is shared with an account that stays",
  ],
  [
    "a stay that checked out yesterday in UTC",
    `INSERT INTO booking.guest_bookings (property_id, public_reference, lifecycle_status, check_in, check_out, currency)
     VALUES ('${APPROVED_HOTEL}', 'VAY2602-UPCOMING', 'pending_payment',
             (now() AT TIME ZONE 'UTC')::date - 3, (now() AT TIME ZONE 'UTC')::date - 1, 'EUR')`,
    "DELETE FROM booking.guest_bookings WHERE public_reference = 'VAY2602-UPCOMING'",
    "VAY-2602: a hotel has an upcoming booking",
  ],
  [
    "a degraded channel",
    `INSERT INTO pms.channel_connections (property_id, provider, connection_status) VALUES (${LEFTOVER_HOTEL}, 'channex', 'degraded')`,
    `DELETE FROM pms.channel_connections WHERE property_id = ${LEFTOVER_HOTEL}`,
    "VAY-2602: a hotel has a connected channel",
  ],
  [
    "an authorized payment",
    `INSERT INTO finance.payments (property_id, payment_kind, status, amount, currency)
     VALUES ('${APPROVED_HOTEL}', 'full', 'authorized', 10, 'EUR')`,
    `DELETE FROM finance.payments WHERE property_id = '${APPROVED_HOTEL}'`,
    "VAY-2602: a hotel has an unresolved payment",
  ],
  [
    "a pending card refund",
    `INSERT INTO finance.card_refund_commands (id, property_id, guest_booking_id, payment_id, idempotency_key,
       requested_by, amount, amount_minor, currency, provider_account_ref, provider_payment_intent_id)
     VALUES ('${id(410)}', '${APPROVED_HOTEL}', '${id(411)}', '${id(412)}', 'vay2602-refund', 'host', 10, 1000, 'EUR',
       'acct_vay2602', 'pi_vay2602')`,
    `DELETE FROM finance.card_refund_commands WHERE id = '${id(410)}'`,
    "VAY-2602: a hotel has an unresolved payment",
  ],
  [
    "a scheduled payout",
    `INSERT INTO finance.payouts (owner_scope, property_id, property_provider_account_id, payout_status, amount, currency)
     VALUES ('property', ${LEFTOVER_HOTEL}, '${id(400)}', 'scheduled', 10, 'EUR')`,
    `DELETE FROM finance.payouts WHERE property_id = ${LEFTOVER_HOTEL}`,
    "VAY-2602: a hotel has an open payout or live payout money",
  ],
  [
    "a live hotel payout not sent yet",
    `INSERT INTO finance.hotel_payouts (property_id, command_id, currency, amount_minor, livemode, cutoff,
       payout_destination_id, started_by_user_id)
     VALUES ('${APPROVED_HOTEL}', '${id(420)}', 'EUR', 1000, true, current_date, '${id(421)}', '${STAFF}')`,
    `DELETE FROM finance.hotel_payouts WHERE command_id = '${id(420)}'`,
    "VAY-2602: a hotel has an open payout or live payout money",
  ],
  [
    "live payout ledger money",
    `INSERT INTO finance.hotel_payout_ledger (property_id, entry_kind, currency, gross_minor, fee_minor, net_minor,
       livemode, source_key, occurred_at)
     VALUES (${LEFTOVER_HOTEL}, 'adjustment', 'EUR', 1000, 0, 1000, true, 'vay2602-ledger', now())`,
    "DELETE FROM finance.hotel_payout_ledger WHERE source_key = 'vay2602-ledger'",
    "VAY-2602: a hotel has an open payout or live payout money",
  ],
  [
    "a custom domain",
    `INSERT INTO hotel_catalog.property_domains (property_id, hostname, verification_status)
     VALUES ('${APPROVED_HOTEL}', 'vay2602.example.test', 'pending')`,
    `DELETE FROM hotel_catalog.property_domains WHERE property_id = '${APPROVED_HOTEL}'`,
    "VAY-2602: a hotel has a custom domain",
  ],
  [
    "an active partner connection",
    `INSERT INTO distribution.partner_connections (client_id, property_id, scopes)
     VALUES ('${id(430)}', ${LEFTOVER_HOTEL}, '{bookings}')`,
    `DELETE FROM distribution.partner_connections WHERE client_id = '${id(430)}'`,
    "VAY-2602: a hotel has an active partner connection",
  ],
  [
    "a live account booking page",
    `INSERT INTO booking.account_booking_pages (organization_id, slug, settings, live)
     VALUES (${leftover(1, 65)}, 'vay2602-page', '{}', true)`,
    `DELETE FROM booking.account_booking_pages WHERE slug = 'vay2602-page'`,
    "VAY-2602: an account booking page is live",
  ],
  [
    "a Stripe account on a hotel outside Codexqa",
    `INSERT INTO finance.payment_provider_accounts (account_scope, property_id, provider, provider_account_id)
     VALUES ('property', '${APPROVED_HOTEL}', 'stripe', 'acct_vay2602_other')`,
    "DELETE FROM finance.payment_provider_accounts WHERE provider_account_id = 'acct_vay2602_other'",
    "VAY-2602: an approved account has a Stripe account",
  ],
  [
    "a Stripe account on an approved account itself",
    `INSERT INTO finance.payment_provider_accounts (account_scope, organization_id, provider, provider_account_id)
     VALUES ('organization', ${leftover(1, 66)}, 'stripe', 'acct_vay2602_org')`,
    "DELETE FROM finance.payment_provider_accounts WHERE provider_account_id = 'acct_vay2602_org'",
    "VAY-2602: an approved account has a Stripe account",
  ],
];

/** A fresh database migrated to 0554, with 0555 ready to apply. */
async function prepare(admin: pg.Client, database: string) {
  const targetUrl = new globalThis.URL(URL!);
  targetUrl.pathname = `/${database}`;
  const dir = await mkdtemp(join(tmpdir(), "vayada-2602-unused-accounts-"));
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  let file = "";
  for (const name of await readdir(MIGRATIONS)) {
    if (!/^\d{4}_/.test(name)) continue;
    const version = Number(name.slice(0, 4));
    if (version < MIGRATION) await cp(join(MIGRATIONS, name), join(dir, name));
    if (version === MIGRATION) file = name;
  }
  expect(file).toBe("0555_archive_unused_hotel_accounts.sql");
  const run = () =>
    runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
  expect((await run()).failed).toBeNull();
  const db = new pg.Client({ connectionString: targetUrl.href });
  await db.connect();
  return {
    db,
    run,
    // Checks and NOT NULL apply; replica mode only skips triggers and foreign-key checks.
    write: (sql: string) =>
      db.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`),
    addMigration: () => cp(join(MIGRATIONS, file), join(dir, file)),
    drop: async () => {
      await db.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function state(db: pg.Client) {
  return (
    await db.query(
      `SELECT
         (SELECT count(*)::int FROM identity.organizations WHERE kind = 'hotel_group' AND status = 'active') AS active,
         (SELECT count(*)::int FROM identity.organizations WHERE kind = 'hotel_group' AND status = 'archived') AS archived,
         (SELECT count(*)::int FROM hotel_catalog.properties WHERE lifecycle_status = 'retired') AS retired,
         (SELECT count(*)::int FROM distribution.active_public_booking_revision) AS pages,
         (SELECT count(*)::int FROM platform.product_audit_events WHERE audit_key LIKE 'vay2602-0555:%') AS audits,
         (SELECT count(*)::int FROM identity.organization_memberships) AS memberships,
         (SELECT count(*)::int FROM identity.organization_resource_links) AS links,
         (SELECT count(*)::int FROM booking.guest_bookings) AS bookings,
         (SELECT count(*)::int FROM finance.payment_provider_accounts) AS providers`,
    )
  ).rows[0];
}

// 3 kept + 1 September + 22 named + 70 leftovers active; one already archived.
const SEEDED = {
  active: 96,
  archived: 1,
  retired: 1,
  pages: 2,
  audits: 0,
  memberships: 1,
  links: 82,
  bookings: 2,
  providers: 1,
};

// VAY-2602: exactly the accounts on Flamur's list are archived and their hotels retired; nothing is
// deleted and every other account stays as it was.
describe.skipIf(!URL)("unused hotel accounts archive 0555", () => {
  it("changes nothing in a database without the listed accounts", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    const target = await prepare(admin, `${DATABASE}_other`);
    try {
      // Staging, local and test databases hold none of the 21 named accounts; August look-alikes stay.
      await target.write(SEED);
      await target.write(
        `DELETE FROM identity.organization_resource_links WHERE organization_id IN (
           SELECT id FROM identity.organizations WHERE workos_org_id = ANY(ARRAY['${NAMED.join("','")}']));
         DELETE FROM identity.organizations WHERE workos_org_id = ANY(ARRAY['${NAMED.join("','")}'])`,
      );
      const seeded = await state(target.db);
      expect(seeded).toMatchObject({ active: 74, archived: 1, audits: 0 });
      await target.addMigration();
      expect((await target.run()).failed).toBeNull();
      expect(await state(target.db)).toEqual(seeded);
    } finally {
      await target.drop();
      await admin.end();
    }
  }, 240_000);

  it("stops on each gate, then archives exactly the list and retires its hotels", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    const target = await prepare(admin, DATABASE);
    const db = target.db;
    try {
      await target.write(SEED);
      expect(await state(db)).toEqual(SEEDED);

      await target.addMigration();
      for (const [label, trip, undo, message] of GATES) {
        await target.write(trip);
        expect({ label, failed: (await target.run()).failed }).toEqual({ label, failed: "0555" });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0555' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await target.write(undo);
        expect({ label, state: await state(db) }).toEqual({ label, state: SEEDED });
      }

      // WorkOS archived one named account and one leftover before this ran: both stay archived, and
      // the named one's hotel is still retired.
      await target.write(
        `UPDATE identity.organizations SET status = 'archived' WHERE id IN ('${named(1)}', ${leftover(1, 5)})`,
      );
      expect((await target.run()).failed).toBeNull();

      const accounts = (
        await db.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM identity.organizations
           WHERE id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)
           GROUP BY status ORDER BY status`,
          [TIGA, OUTSIDE_SIGNUP, SEPTEMBER, PLATFORM, CLOSED, KEPT_AUGUST],
        )
      ).rows;
      // The kept, September and platform accounts stay active; the closed one stays archived.
      expect(accounts).toEqual([
        { status: "active", n: 5 },
        { status: "archived", n: 1 },
      ]);
      const listed = (
        await db.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM identity.organizations
           WHERE workos_org_id = ANY($1::text[]) OR workos_org_id LIKE 'org_vay2602_gone_%'
           GROUP BY status`,
          [NAMED],
        )
      ).rows;
      expect(listed).toEqual([{ status: "archived", n: 92 }]);

      // 17 named hotels and 58 leftover hotels are retired now; the one retired before is untouched,
      // and so is the hotel of the leftover archived before this ran.
      const hotels = (
        await db.query(
          `SELECT property.lifecycle_status AS lifecycle, property.profile_status AS profile,
                  property.pre_hold_profile_status AS "preHold", property.lifecycle_revision::int AS revision,
                  property.retired_by_user_id::text AS "retiredBy", count(*)::int AS n
           FROM hotel_catalog.properties property
           GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3 NULLS FIRST, 4`,
        )
      ).rows;
      expect(hotels).toEqual([
        {
          lifecycle: "provisioning",
          profile: "incomplete",
          preHold: null,
          revision: 1,
          retiredBy: null,
          n: 6,
        },
        {
          lifecycle: "retired",
          profile: "disabled",
          preHold: null,
          revision: 1,
          retiredBy: STAFF,
          n: 1,
        },
        {
          lifecycle: "retired",
          profile: "disabled",
          preHold: "incomplete",
          revision: 2,
          retiredBy: STAFF,
          n: 75,
        },
      ]);
      const untouched = (
        await db.query<{ id: string }>(
          `SELECT id::text FROM hotel_catalog.properties WHERE lifecycle_status <> 'retired' ORDER BY id`,
        )
      ).rows.map((row) => row.id);
      expect(untouched).toEqual(
        [
          TIGA_HOTEL,
          OUTSIDE_SIGNUP_HOTEL,
          SEPTEMBER_HOTEL,
          CLOSED_HOTEL,
          KEPT_AUGUST_HOTEL,
          "55500000-0000-4000-8002-000000000005",
        ].sort(),
      );

      const pages = (
        await db.query(
          `SELECT property.id::text AS id, profile.profile_status AS profile, profile.freshness_status AS freshness,
                  revision.property_id IS NOT NULL AS live
           FROM hotel_catalog.properties property
           JOIN distribution.public_hotel_bookability_profiles profile ON profile.property_id = property.id
           LEFT JOIN distribution.active_public_booking_revision revision ON revision.property_id = property.id
           ORDER BY property.id`,
        )
      ).rows;
      expect(pages).toEqual([
        { id: OUTSIDE_SIGNUP_HOTEL, profile: "public", freshness: "fresh", live: true },
        {
          id: namedHotel(TESTE1234),
          profile: "unavailable",
          freshness: "unavailable",
          live: false,
        },
      ]);

      const audits = (
        await db.query(
          `SELECT product, action, tenant_scope AS scope, actor_type AS actor,
                  actor_user_id::text AS "actorUser", count(*)::int AS n
           FROM platform.product_audit_events WHERE audit_key LIKE 'vay2602-0555:%'
           GROUP BY 1, 2, 3, 4, 5 ORDER BY 1`,
        )
      ).rows;
      expect(audits).toEqual([
        {
          product: "hotel_catalog",
          action: "platform.property.lifecycle.retire",
          scope: "property",
          actor: "migration",
          actorUser: STAFF,
          n: 75,
        },
        {
          product: "identity",
          action: "identity.organization.archive",
          scope: "organization",
          actor: "migration",
          actorUser: STAFF,
          n: 90,
        },
      ]);

      // Nothing is deleted: memberships, links, bookings and the Stripe test account stay.
      expect(await state(db)).toEqual({
        ...SEEDED,
        active: 4,
        archived: 93,
        retired: 76,
        pages: 1,
        audits: 165,
      });
    } finally {
      await target.drop();
      await admin.end();
    }
  }, 240_000);
});
