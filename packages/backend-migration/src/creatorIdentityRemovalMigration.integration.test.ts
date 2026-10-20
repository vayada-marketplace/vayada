import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_creator_identity_removal_test";
const MIGRATION = 500;

const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLOSED_ORG = id(1); // creator workspace WorkOS knows: kept as a blank row
const EMPTY_ORG = id(2); // creator workspace nothing names: deleted
const PAYEE_ORG = id(3); // affiliate partner with a billing record: archived, name kept
const HOTEL_ORG = id(4);
const WORKOS_USER = id(11); // creator only, WorkOS knows them: blank row, WorkOS link kept
const PLAIN_USER = id(12); // creator only, nothing names them: deleted
const LEGACY_TYPE_USER = id(13); // created as a creator, no membership: deleted
const AUDITED_USER = id(14); // creator only, named by an audit event: blank row
const DUAL_USER = id(15); // creator and hotel member: stays
const PROPERTY = id(21);
const MARKED_MEDIA = id(31);
const EXTERNAL_MEDIA = id(32);
const HOTEL_MEDIA = id(33);
const UNMARKED_MEDIA = id(34);
const SESSION = id(41);

const MEDIA_COLUMNS = `(id, bucket, storage_key, storage_kind, visibility, purpose, owner_organization_id,
  property_id, resource_product, resource_type, resource_id, lifecycle_status, public_approved,
  source_url, created_by_user_id, source_metadata)`;

const SEED = `
  INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id) VALUES
    ('${CLOSED_ORG}', 'creator_workspace', 'Closed creator', 'closed-creator', 'org_closed_creator'),
    ('${EMPTY_ORG}', 'creator_workspace', 'Empty creator', 'empty-creator', NULL),
    ('${PAYEE_ORG}', 'affiliate_partner', 'Paid affiliate', 'paid-affiliate', NULL),
    ('${HOTEL_ORG}', 'hotel_group', 'Kept hotel', 'kept-hotel', NULL);
  INSERT INTO identity.users (id, email, name) VALUES
    ('${WORKOS_USER}', 'workos-creator@example.test', 'WorkOS Creator'),
    ('${PLAIN_USER}', 'plain-creator@example.test', 'Plain Creator'),
    ('${LEGACY_TYPE_USER}', 'legacy-type@example.test', 'Legacy Type'),
    ('${AUDITED_USER}', 'audited-creator@example.test', 'Audited Creator'),
    ('${DUAL_USER}', 'dual@example.test', 'Dual Member');
  INSERT INTO identity.organization_memberships
    (organization_id, user_id, role_key, access_origin, property_access_mode) VALUES
    ('${CLOSED_ORG}', '${WORKOS_USER}', 'creator_owner', 'agency', 'all'),
    ('${EMPTY_ORG}', '${PLAIN_USER}', 'creator_owner', 'agency', 'all'),
    ('${EMPTY_ORG}', '${AUDITED_USER}', 'creator_owner', 'agency', 'all'),
    ('${CLOSED_ORG}', '${DUAL_USER}', 'creator_owner', 'agency', 'all'),
    ('${HOTEL_ORG}', '${DUAL_USER}', 'hotel_owner', 'agency', 'all');
  INSERT INTO identity.external_identities
    (user_id, provider, provider_user_id, provider_email, provider_email_verified, raw_profile)
    VALUES ('${WORKOS_USER}', 'workos', 'user_workos_creator', 'workos-creator@example.test', TRUE,
            '{"first_name": "WorkOS"}');
  INSERT INTO identity.auth_reconciliation_events
    (event_type, provider, provider_event_id, user_id, payload) VALUES
    ('identity.user.created', 'workos', NULL, '${LEGACY_TYPE_USER}',
     '{"payload": {"legacyUserType": "creator"}}'),
    ('workos.webhook.normalized', 'workos', 'event_workos_creator', '${WORKOS_USER}',
     '{"email": "workos-creator@example.test"}');
  INSERT INTO identity.user_consent_status (user_id, terms_accepted_at, terms_version)
    VALUES ('${PLAIN_USER}', now(), 'v1');
  INSERT INTO identity.gdpr_requests (user_id, request_type, status, processed_at)
    VALUES ('${PLAIN_USER}', 'export', 'completed', now());
  INSERT INTO hotel_catalog.properties (id, public_id, display_name, creation_organization_id)
    VALUES ('${PROPERTY}', '${PROPERTY}', 'Kept hotel', '${HOTEL_ORG}');
  INSERT INTO identity.organization_resource_links
    (organization_id, product, resource_type, resource_id, relationship) VALUES
    ('${HOTEL_ORG}', 'marketplace', 'hotel_profile', '${PROPERTY}', 'owner'),
    ('${HOTEL_ORG}', 'booking', 'booking_hotel', '${PROPERTY}', 'owner');
  INSERT INTO finance.billing_entitlements
    (organization_id, product, entitlement_key, billing_status, billing_provider)
    VALUES ('${PAYEE_ORG}', 'affiliate', 'affiliate-partner', 'active', 'manual');
  INSERT INTO platform.product_audit_events
    (audit_key, product, action, occurred_at, tenant_scope, actor_type, actor_user_id,
     target_resource_product, target_resource_type, target_resource_id)
    VALUES ('vay2272-audited', 'identity', 'auth.login.succeeded', now(), 'migration', 'user',
            '${AUDITED_USER}', 'identity', 'user', '${AUDITED_USER}');
  INSERT INTO platform.media_objects ${MEDIA_COLUMNS} VALUES
    ('${MARKED_MEDIA}', 'test-media', 'private/media/${MARKED_MEDIA}/original/image.jpg',
     'vayada_managed', 'private', 'marketplace.offer.media', '${CLOSED_ORG}', NULL,
     'marketplace', 'marketplace_offer', 'offer-marked', 'active', FALSE, NULL, NULL,
     '{"retiredPurgeCompletedAt": "2026-10-20T00:00:00.000Z"}'),
    ('${EXTERNAL_MEDIA}', NULL, NULL, 'external_reference', 'private', 'identity.user.profile_image',
     NULL, NULL, 'platform', 'user', '${PLAIN_USER}', 'external_reference', FALSE,
     'https://legacy.example.test/creator.jpg', '${PLAIN_USER}', '{}'),
    ('${HOTEL_MEDIA}', 'test-media', 'private/media/${HOTEL_MEDIA}/original/image.jpg',
     'vayada_managed', 'private', 'identity.user.profile_image', '${HOTEL_ORG}', NULL,
     'platform', 'user', '${DUAL_USER}', 'active', FALSE, NULL, '${DUAL_USER}', '{}');
  UPDATE identity.users SET profile_picture_media_object_id = '${EXTERNAL_MEDIA}'
    WHERE id = '${PLAIN_USER}';
  UPDATE identity.users SET profile_picture_media_object_id = '${HOTEL_MEDIA}'
    WHERE id = '${DUAL_USER}';
  INSERT INTO platform.jobs
    (job_key, queue_name, job_type, status, attempts_count, max_attempts, run_after,
     resource_product, resource_type, resource_id, job_metadata)
    VALUES ('vay2272-marketplace-job', 'platform.default', 'marketplace.offer.sync', 'pending', 0, 1,
            now(), 'marketplace', 'marketplace_offer', 'offer-1', '{}')`;

// Each gate stops 0500 before it changes anything: [case, row that trips it, undo, message].
const GATES: [string, string, string, string][] = [
  [
    "creator media still has its file",
    `INSERT INTO platform.media_objects ${MEDIA_COLUMNS} VALUES
       ('${UNMARKED_MEDIA}', 'test-media', 'private/media/${UNMARKED_MEDIA}/original/image.jpg',
        'vayada_managed', 'private', 'marketplace.offer.media', '${CLOSED_ORG}', NULL,
        'marketplace', 'marketplace_offer', 'offer-unmarked', 'active', FALSE, NULL, NULL, '{}')`,
    `DELETE FROM platform.media_objects WHERE id = '${UNMARKED_MEDIA}'`,
    "Creator media stored by Vayada without the purge marker",
  ],
  [
    "a hotel gallery uses creator media",
    `INSERT INTO hotel_catalog.property_media
       (property_id, media_type, url, source_system, platform_media_object_id)
       VALUES ('${PROPERTY}', 'gallery_image', 'https://legacy.example.test/creator.jpg', 'platform',
               '${EXTERNAL_MEDIA}')`,
    `DELETE FROM hotel_catalog.property_media WHERE property_id = '${PROPERTY}'`,
    "Hotel data or a kept user still uses creator media",
  ],
  [
    "a hotel logo is creator media",
    `INSERT INTO booking.booking_settings (property_id, header_logo_media_object_id)
       VALUES ('${PROPERTY}', '${MARKED_MEDIA}')`,
    `DELETE FROM booking.booking_settings WHERE property_id = '${PROPERTY}'`,
    "Hotel data or a kept user still uses creator media",
  ],
  [
    "a kept user's picture is creator media",
    `UPDATE identity.users SET profile_picture_media_object_id = upper('${MARKED_MEDIA}')
       WHERE id = '${DUAL_USER}'`,
    `UPDATE identity.users SET profile_picture_media_object_id = '${HOTEL_MEDIA}'
       WHERE id = '${DUAL_USER}'`,
    "Hotel data or a kept user still uses creator media",
  ],
  [
    "a creator upload is in flight",
    `INSERT INTO platform.media_upload_sessions
       (id, upload_session_key, requested_purpose, requested_visibility, resource_product,
        resource_type, staging_prefix, expires_at, session_status, actor_user_id)
       VALUES ('${SESSION}', 'media.upload_session:${SESSION}', 'identity.user.profile_image',
               'private', 'platform', 'user', 'staging/${SESSION}', now() + interval '1 hour',
               'signed', '${PLAIN_USER}')`,
    `DELETE FROM platform.media_upload_sessions WHERE id = '${SESSION}'`,
    "Creator uploads still in flight",
  ],
  [
    "a removed user has an open GDPR request",
    `INSERT INTO identity.gdpr_requests (user_id, request_type, status)
       VALUES ('${PLAIN_USER}', 'deletion', 'pending')`,
    `DELETE FROM identity.gdpr_requests WHERE status = 'pending'`,
    "Open GDPR requests of creator users",
  ],
];

// 0500 deals with each of these before a delete reaches it; a new one needs a look.
const SILENT_REFERENCES = [
  "identity.organization_memberships <- identity.account_admin_transfer_proofs(actor_membership_id) c",
  "identity.organization_memberships <- identity.account_admin_transfer_proofs(target_membership_id) c",
  "identity.organization_memberships <- identity.membership_delegations(organization_id,subject_membership_id) c",
  "identity.organization_memberships <- identity.membership_property_assignments(membership_id) c",
  "identity.organization_memberships <- pms.message_threads(assigned_to_membership_id) n",
  "identity.organizations <- hotel_catalog.organization_setup_track_intents(organization_id) c",
  "identity.organizations <- hotel_catalog.property_setup_sessions(organization_id) c",
  "identity.organizations <- identity.account_admin_guards(organization_id) c",
  "identity.organizations <- identity.account_admin_transfer_proofs(organization_id) c",
  "identity.organizations <- identity.organization_roles(organization_id) c",
  "identity.users <- distribution.external_api_clients(created_by_user_id) n",
  "identity.users <- distribution.external_api_clients(revoked_by_user_id) n",
  "identity.users <- finance.commission_rate_changes(changed_by_user_id) n",
  "identity.users <- hotel_catalog.hotel_account_invites(created_by_user_id) n",
  "identity.users <- hotel_catalog.hotel_account_invites(redeemed_by_user_id) n",
  "identity.users <- identity.consent_history(user_id) n",
  "identity.users <- identity.cookie_consents(user_id) n",
  "identity.users <- identity.gdpr_requests(user_id) c",
  "identity.users <- pms.booking_notes_private(edited_by_user_id) n",
  "platform.media_objects <- booking.booking_settings(header_logo_media_object_id) n",
  "platform.media_objects <- platform.media_variants(media_object_id,visibility) c deferred",
];

// VAY-2272: the creator and affiliate side of identity goes; hotels, payees and WorkOS links stay.
describe.skipIf(!URL)("creator identity and media removal 0500", () => {
  it("stops on each gate, then removes creators and keeps what others still name", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-creator-removal-"));
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
      // Checks and NOT NULL apply; replica mode only skips triggers and foreign-key checks.
      const write = (sql: string) =>
        db.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`);

      const silent = await db.query<{ name: string }>(
        `SELECT c.confrelid::regclass::text || ' <- ' || c.conrelid::regclass::text || '(' ||
                (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) ||
                ') ' || c.confdeltype || CASE WHEN c.condeferred THEN ' deferred' ELSE '' END AS name
         FROM pg_catalog.pg_constraint c
         WHERE c.contype = 'f' AND (c.confdeltype IN ('c', 'n', 'd') OR c.condeferred)
           AND c.confrelid IN ('identity.users'::regclass, 'identity.organizations'::regclass,
                               'identity.organization_memberships'::regclass,
                               'platform.media_objects'::regclass)`,
      );
      expect(silent.rows.map((row) => row.name).sort()).toEqual([...SILENT_REFERENCES].sort());

      await write(SEED);
      const state = async () =>
        (
          await db.query(
            `SELECT
               (SELECT count(*)::int FROM identity.organizations WHERE status = 'active') AS organizations,
               (SELECT count(*)::int FROM identity.users WHERE status = 'active') AS users,
               (SELECT count(*)::int FROM identity.organization_memberships) AS memberships,
               (SELECT count(*)::int FROM identity.organization_resource_links) AS links,
               (SELECT count(*)::int FROM identity.external_identities
                WHERE provider_email IS NOT NULL) AS identities,
               (SELECT count(*)::int FROM identity.auth_reconciliation_events
                WHERE user_id IS NOT NULL) AS events,
               (SELECT count(*)::int FROM identity.user_consent_status) AS consents,
               (SELECT count(*)::int FROM identity.gdpr_requests) AS requests,
               (SELECT count(*)::int FROM platform.media_objects) AS media,
               (SELECT count(*)::int FROM platform.jobs WHERE status = 'pending') AS jobs`,
          )
        ).rows[0];
      const seeded = {
        organizations: 4,
        users: 5,
        memberships: 5,
        links: 2,
        identities: 1,
        events: 2,
        consents: 1,
        requests: 1,
        media: 3,
        jobs: 1,
      };
      expect(await state()).toEqual(seeded);

      // Later migrations may change what this checks, so it stops at 0500.
      await cp(join(MIGRATIONS, file), join(before, file));
      for (const [label, trip, undo, message] of GATES) {
        await write(trip);
        expect({ label, failed: (await run(before)).failed }).toEqual({ label, failed: "0500" });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0500' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await write(undo);
        expect({ label, state: await state() }).toEqual({ label, state: seeded });
      }

      expect((await run(before)).failed).toBeNull();

      expect(await state()).toEqual({
        organizations: 1,
        users: 1,
        memberships: 1,
        links: 1,
        identities: 0,
        events: 0,
        consents: 0,
        requests: 0,
        media: 1,
        jobs: 0,
      });
      expect(
        (
          await db.query(
            `SELECT id::text, status, name, slug, workos_org_id FROM identity.organizations
             ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        {
          id: CLOSED_ORG,
          status: "archived",
          name: "Removed workspace",
          slug: `removed-${CLOSED_ORG}`,
          workos_org_id: "org_closed_creator",
        },
        {
          id: PAYEE_ORG,
          status: "archived",
          name: "Paid affiliate",
          slug: "paid-affiliate",
          workos_org_id: null,
        },
        {
          id: HOTEL_ORG,
          status: "active",
          name: "Kept hotel",
          slug: "kept-hotel",
          workos_org_id: null,
        },
      ]);
      expect(
        (
          await db.query(
            `SELECT id::text, status, email, name, profile_picture_media_object_id AS picture
             FROM identity.users ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        {
          id: WORKOS_USER,
          status: "deleted",
          email: `removed-${WORKOS_USER}@removed.invalid`,
          name: null,
          picture: null,
        },
        {
          id: AUDITED_USER,
          status: "deleted",
          email: `removed-${AUDITED_USER}@removed.invalid`,
          name: null,
          picture: null,
        },
        {
          id: DUAL_USER,
          status: "active",
          email: "dual@example.test",
          name: "Dual Member",
          picture: HOTEL_MEDIA,
        },
      ]);
      // WorkOS still finds the closed account, so a late message cannot create a new one.
      expect(
        (
          await db.query(
            `SELECT user_id::text, provider_user_id, provider_email, provider_email_verified,
                    raw_profile, last_login_at
             FROM identity.external_identities`,
          )
        ).rows,
      ).toEqual([
        {
          user_id: WORKOS_USER,
          provider_user_id: "user_workos_creator",
          provider_email: null,
          provider_email_verified: false,
          raw_profile: null,
          last_login_at: null,
        },
      ]);
      // The WorkOS marker stays without who it was about; the creation event goes.
      expect(
        (
          await db.query(
            `SELECT event_type, provider_event_id, user_id, payload
             FROM identity.auth_reconciliation_events`,
          )
        ).rows,
      ).toEqual([
        {
          event_type: "workos.webhook.normalized",
          provider_event_id: "event_workos_creator",
          user_id: null,
          payload: null,
        },
      ]);
      expect(
        (
          await db.query(
            `SELECT
               (SELECT array_agg(organization_id::text || ' ' || role_key)
                FROM identity.organization_memberships) AS memberships,
               (SELECT array_agg(product) FROM identity.organization_resource_links) AS links,
               (SELECT array_agg(id::text) FROM platform.media_objects) AS media,
               (SELECT array_agg(status) FROM platform.jobs) AS jobs,
               (SELECT array_agg(organization_id::text) FROM finance.billing_entitlements) AS billing`,
          )
        ).rows,
      ).toEqual([
        {
          memberships: [`${HOTEL_ORG} hotel_owner`],
          links: ["booking"],
          media: [HOTEL_MEDIA],
          jobs: ["canceled"],
          billing: [PAYEE_ORG],
        },
      ]);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
