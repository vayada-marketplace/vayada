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
const EMPTY_ORG = id(2); // creator workspace nothing kept names: deleted, with its unused finance rows
const PAYEE_ORG = id(3); // affiliate partner with a payout and billing: archived, name kept
const HOTEL_ORG = id(4);
const FALLBACK_ORG = id(6); // creator workspace a retired hotel still names: blank row, one by one
const WORKOS_USER = id(11); // creator only, WorkOS knows them: blank row, WorkOS link kept
const PLAIN_USER = id(12); // creator only, nothing kept names them: deleted
const LEGACY_TYPE_USER = id(13); // created as a creator, no membership: deleted
const AUDITED_USER = id(14); // creator only, named by an audit event: blank row
const DUAL_USER = id(15); // creator and hotel member: stays
const INVITER_USER = id(17); // creator who created a hotel invite (set-null column): blank row
const FALLBACK_USER = id(18); // creator a retired hotel still names: blank row, one by one
const PROPERTY = id(21);
const RETIRED_PROPERTY = id(22);
const OWNERLESS_PROPERTY = id(23);
const MARKED_MEDIA = id(31);
const EXTERNAL_MEDIA = id(32);
const HOTEL_MEDIA = id(33);
const UNMARKED_MEDIA = id(34);
const SESSION = id(41);
const OLD_SESSION = id(42);
const KEPT_ACCOUNT = id(71);
const KEPT_SETTING = id(72);
const UNUSED_ACCOUNT = id(73);
const UNUSED_SETTING = id(74);
const ENTITLEMENT = id(81);
const DOMAIN_EVENT = id(91);

const MEDIA_COLUMNS = `(id, bucket, storage_key, storage_kind, visibility, purpose, owner_organization_id,
  property_id, resource_product, resource_type, resource_id, lifecycle_status, public_approved,
  source_url, created_by_user_id, source_metadata)`;

const SEED = `
  INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id, website_url) VALUES
    ('${CLOSED_ORG}', 'creator_workspace', 'Closed creator', 'closed-creator', 'org_closed_creator', NULL),
    ('${EMPTY_ORG}', 'creator_workspace', 'Empty creator', 'empty-creator', NULL, NULL),
    ('${PAYEE_ORG}', 'affiliate_partner', 'Paid affiliate', 'paid-affiliate', NULL, 'https://affiliate.example.test'),
    ('${HOTEL_ORG}', 'hotel_group', 'Kept hotel', 'kept-hotel', NULL, NULL),
    ('${FALLBACK_ORG}', 'creator_workspace', 'Fallback creator', 'fallback-creator', NULL, NULL);
  INSERT INTO identity.users (id, email, name) VALUES
    ('${WORKOS_USER}', 'workos-creator@example.test', 'WorkOS Creator'),
    ('${PLAIN_USER}', 'plain-creator@example.test', 'Plain Creator'),
    ('${LEGACY_TYPE_USER}', 'legacy-type@example.test', 'Legacy Type'),
    ('${AUDITED_USER}', 'audited-creator@example.test', 'Audited Creator'),
    ('${DUAL_USER}', 'dual@example.test', 'Dual Member'),
    ('${INVITER_USER}', 'inviter-creator@example.test', 'Inviter Creator'),
    ('${FALLBACK_USER}', 'fallback-creator@example.test', 'Fallback Creator');
  INSERT INTO identity.organization_memberships
    (organization_id, user_id, role_key, access_origin, property_access_mode) VALUES
    ('${CLOSED_ORG}', '${WORKOS_USER}', 'creator_owner', 'agency', 'all'),
    ('${EMPTY_ORG}', '${PLAIN_USER}', 'creator_owner', 'agency', 'all'),
    ('${EMPTY_ORG}', '${AUDITED_USER}', 'creator_owner', 'agency', 'all'),
    ('${EMPTY_ORG}', '${INVITER_USER}', 'creator_owner', 'agency', 'all'),
    ('${CLOSED_ORG}', '${DUAL_USER}', 'creator_owner', 'agency', 'all'),
    ('${HOTEL_ORG}', '${DUAL_USER}', 'hotel_owner', 'agency', 'all'),
    ('${FALLBACK_ORG}', '${FALLBACK_USER}', 'creator_owner', 'agency', 'all');
  INSERT INTO identity.external_identities
    (user_id, provider, provider_user_id, provider_email, provider_email_verified, raw_profile) VALUES
    ('${WORKOS_USER}', 'workos', 'user_workos_creator', 'workos-creator@example.test', TRUE,
     '{"first_name": "WorkOS"}'),
    ('${AUDITED_USER}', 'workos', NULL, 'audited-creator@example.test', FALSE, NULL),
    ('${FALLBACK_USER}', 'workos', NULL, 'fallback-creator@example.test', FALSE, NULL);
  INSERT INTO identity.auth_reconciliation_events
    (event_type, provider, provider_event_id, user_id, organization_id, payload) VALUES
    ('identity.user.created', 'workos', NULL, '${LEGACY_TYPE_USER}', NULL,
     '{"payload": {"legacyUserType": "creator"}}'),
    ('workos.webhook.normalized', 'workos', 'event_workos_creator', '${WORKOS_USER}', NULL,
     '{"receiptId": "event_workos_creator", "status": "normalized"}'),
    ('workos.webhook.ignored', 'workos', 'event_workos_workspace', NULL, '${CLOSED_ORG}',
     '{"receiptId": "event_workos_workspace", "status": "ignored"}');
  INSERT INTO identity.user_consent_status (user_id, terms_accepted_at, terms_version)
    VALUES ('${PLAIN_USER}', now(), 'v1');
  INSERT INTO identity.consent_history (user_id, consent_type, consent_given)
    VALUES ('${PLAIN_USER}', 'terms', TRUE);
  INSERT INTO identity.cookie_consents (visitor_id, user_id) VALUES ('visitor-plain-creator', '${PLAIN_USER}');
  INSERT INTO identity.gdpr_requests (user_id, request_type, status, processed_at)
    VALUES ('${PLAIN_USER}', 'export', 'completed', now());
  INSERT INTO hotel_catalog.properties (id, public_id, display_name, creation_organization_id)
    VALUES ('${PROPERTY}', '${PROPERTY}', 'Kept hotel', '${HOTEL_ORG}');
  INSERT INTO hotel_catalog.properties
    (id, public_id, display_name, creation_organization_id, lifecycle_status, retired_at, retired_by_user_id)
    VALUES ('${RETIRED_PROPERTY}', '${RETIRED_PROPERTY}', 'Retired hotel', '${FALLBACK_ORG}', 'retired', now(),
            '${FALLBACK_USER}');
  INSERT INTO hotel_catalog.hotel_account_invites (code, invite_type, created_by_user_id)
    VALUES ('VAY-2272-CREATOR', 'hotel', '${INVITER_USER}');
  INSERT INTO identity.organization_resource_links
    (organization_id, product, resource_type, resource_id, relationship) VALUES
    ('${HOTEL_ORG}', 'marketplace', 'hotel_profile', '${PROPERTY}', 'owner'),
    ('${HOTEL_ORG}', 'booking', 'booking_hotel', '${PROPERTY}', 'owner');
  INSERT INTO identity.product_entitlements (id, organization_id, product, entitlement_key, status, metadata)
    VALUES ('${ENTITLEMENT}', '${HOTEL_ORG}', 'marketplace', 'marketplace-listing', 'active', '{}');
  INSERT INTO finance.billing_entitlements
    (organization_id, identity_entitlement_id, product, entitlement_key, billing_status, billing_provider) VALUES
    ('${PAYEE_ORG}', NULL, 'affiliate', 'affiliate-partner', 'active', 'manual'),
    ('${HOTEL_ORG}', '${ENTITLEMENT}', 'marketplace', 'marketplace-listing', 'active', 'manual');
  INSERT INTO finance.finance_visibility_read_model
    (organization_id, visibility_scope, resource_type, resource_id, required_permission_key, currency)
    VALUES ('${PAYEE_ORG}', 'affiliate_payout', 'affiliate', 'affiliate-payee', 'affiliate.payout.manage', 'EUR');
  INSERT INTO finance.payment_provider_accounts
    (id, account_scope, organization_id, provider, status, onboarding_status) VALUES
    ('${KEPT_ACCOUNT}', 'organization', '${PAYEE_ORG}', 'manual', 'active', 'completed'),
    ('${UNUSED_ACCOUNT}', 'organization', '${EMPTY_ORG}', 'manual', 'pending', 'not_started');
  INSERT INTO finance.payout_settings
    (id, owner_scope, organization_id, organization_provider_account_id, payout_method, default_currency,
     status, source_system) VALUES
    ('${KEPT_SETTING}', 'organization', '${PAYEE_ORG}', '${KEPT_ACCOUNT}', 'bank', 'EUR', 'active', 'finance'),
    ('${UNUSED_SETTING}', 'organization', '${EMPTY_ORG}', '${UNUSED_ACCOUNT}', 'bank', 'EUR', 'active', 'finance');
  INSERT INTO finance.payouts
    (owner_scope, organization_id, payout_setting_id, organization_provider_account_id, source_system,
     payout_status, amount, fee_amount, net_amount, currency)
    VALUES ('organization', '${PAYEE_ORG}', '${KEPT_SETTING}', '${KEPT_ACCOUNT}', 'finance', 'paid', 100, 0, 100,
            'EUR');
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
  INSERT INTO platform.media_variants (media_object_id, variant_name, visibility, storage_key, content_type)
    VALUES ('${MARKED_MEDIA}', 'thumbnail', 'private', 'private/media/${MARKED_MEDIA}/thumbnail/v1.webp',
            'image/webp');
  INSERT INTO platform.production_media_migration_items
    (source_run_id, source_system, source_table, source_row_id, purpose, source_field, source_url,
     source_updated_at, source_reference_sha256, media_object_id, item_status, content_checksum_sha256,
     completed_at) VALUES
    ('vay2272-media-run', 'marketplace', 'creators', 'creator-1', 'identity.user.profile_image',
     'profile_picture', 'https://legacy.example.test/creator.jpg', now(),
     'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '${EXTERNAL_MEDIA}', 'completed',
     'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', now()),
    ('vay2272-media-run', 'marketplace', 'offers', 'offer-1', 'marketplace.offer.media', 'image',
     'https://legacy.example.test/offer.jpg', now(),
     'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', NULL, 'planned', NULL, NULL);
  INSERT INTO platform.media_upload_sessions
    (id, upload_session_key, requested_purpose, requested_visibility, resource_product, resource_type,
     staging_prefix, expires_at, session_status, actor_user_id)
    VALUES ('${OLD_SESSION}', 'media.upload_session:${OLD_SESSION}', 'identity.user.profile_image', 'private',
            'platform', 'user', 'staging/${OLD_SESSION}', now() - interval '1 day', 'expired', '${PLAIN_USER}');
  UPDATE identity.users SET profile_picture_media_object_id = '${EXTERNAL_MEDIA}'
    WHERE id = '${PLAIN_USER}';
  UPDATE identity.users SET profile_picture_media_object_id = '${HOTEL_MEDIA}'
    WHERE id = '${DUAL_USER}';
  INSERT INTO platform.jobs
    (job_key, queue_name, job_type, status, attempts_count, max_attempts, run_after,
     resource_product, resource_type, resource_id, job_metadata)
    VALUES ('vay2272-marketplace-job', 'platform.default', 'marketplace.offer.sync', 'pending', 0, 1,
            now(), 'marketplace', 'marketplace_offer', 'offer-1', '{}');
  INSERT INTO platform.outbox_events
    (domain_event_id, outbox_key, destination, event_type, tenant_scope, resource_product, resource_type,
     resource_id, status)
    VALUES ('${DOMAIN_EVENT}', 'vay2272-marketplace-outbox', 'jobs', 'marketplace.offer.synced', 'platform',
            'marketplace', 'marketplace_offer', 'offer-1', 'failed')`;

// The membership of WORKOS_USER in CLOSED_ORG, for the gates that point at one.
const CREATOR_MEMBERSHIP = `SELECT m.id FROM identity.organization_memberships m
  WHERE m.organization_id = '${CLOSED_ORG}' AND m.user_id = '${WORKOS_USER}'`;

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
    "creator media still has a rollback copy",
    `UPDATE platform.media_objects
       SET source_metadata = source_metadata || '{"rollbackStorageKey": "private/rollback/image.jpg"}'
       WHERE id = '${MARKED_MEDIA}'`,
    `UPDATE platform.media_objects SET source_metadata = source_metadata - 'rollbackStorageKey'
       WHERE id = '${MARKED_MEDIA}'`,
    "Creator media with a rollback copy still stored",
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
    "a hotel add-on photo is creator media",
    `INSERT INTO booking.addon_definitions (property_id, name, pricing_model, currency, metadata)
       VALUES ('${PROPERTY}', 'Creator breakfast', 'per_stay', 'EUR',
               '{"photos": [{"mediaObjectId": "${MARKED_MEDIA}", "imageUrl": "x", "isCover": true}]}')`,
    `DELETE FROM booking.addon_definitions WHERE property_id = '${PROPERTY}'`,
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
  [
    "a PMS thread is assigned to a creator membership",
    `INSERT INTO pms.message_threads
       (property_id, source, source_thread_id, delivery_channel, assigned_to_membership_id)
       SELECT '${PROPERTY}', 'manual', 'vay2272-thread', 'email', id FROM (${CREATOR_MEMBERSHIP}) creator`,
    `DELETE FROM pms.message_threads WHERE source_thread_id = 'vay2272-thread'`,
    "A PMS thread is assigned to a creator membership",
  ],
  [
    "a creator workspace delegates a membership",
    `INSERT INTO identity.membership_delegations
       (organization_id, subject_membership_id, delegator_membership_id, created_by_membership_id)
       SELECT '${CLOSED_ORG}', subject.id, delegator.id, delegator.id
       FROM identity.organization_memberships subject, identity.organization_memberships delegator
       WHERE subject.organization_id = '${CLOSED_ORG}' AND subject.user_id = '${DUAL_USER}'
         AND delegator.organization_id = '${CLOSED_ORG}' AND delegator.user_id = '${WORKOS_USER}'`,
    `DELETE FROM identity.membership_delegations WHERE organization_id = '${CLOSED_ORG}'`,
    "Staff invitations, delegations or admin transfers in a creator workspace",
  ],
  [
    "a creator membership approved a PMS inbox route",
    `INSERT INTO pms.inbox_email_routes
       (property_id, from_address, sender_status, policy_status, approved_at, approved_by_membership_id)
       SELECT '${PROPERTY}', 'guest@example.test', 'approved', 'allowed', now(), id
       FROM (${CREATOR_MEMBERSHIP}) creator`,
    `DELETE FROM pms.inbox_email_routes WHERE property_id = '${PROPERTY}'`,
    "A PMS inbox route was approved by a creator membership",
  ],
  [
    "a hotel is owned only through its Marketplace link",
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ('${OWNERLESS_PROPERTY}', '${OWNERLESS_PROPERTY}', 'Marketplace-only hotel');
     INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship)
       VALUES ('${HOTEL_ORG}', 'marketplace', 'hotel_profile', '${OWNERLESS_PROPERTY}', 'owner')`,
    `DELETE FROM identity.organization_resource_links WHERE resource_id = '${OWNERLESS_PROPERTY}';
     DELETE FROM hotel_catalog.properties WHERE id = '${OWNERLESS_PROPERTY}'`,
    "A hotel is owned only through its Marketplace link",
  ],
];

// 0500 deals with each of these before a delete reaches it, and its not-in-use checks for payout
// settings and provider accounts name every key into them; a new one needs a look.
const REFERENCES = [
  "finance.payment_provider_accounts <- booking.pending_booking_edit_attempts(provider_account_id,property_id) a",
  "finance.payment_provider_accounts <- finance.online_card_execution_evidence(provider_account_id,property_id) r",
  "finance.payment_provider_accounts <- finance.payment_settings(provider_account_id,property_id) n",
  "finance.payment_provider_accounts <- finance.payments(provider_account_id,property_id) n",
  "finance.payment_provider_accounts <- finance.payout_settings(organization_provider_account_id,organization_id) n",
  "finance.payment_provider_accounts <- finance.payout_settings(property_provider_account_id,property_id) n",
  "finance.payment_provider_accounts <- finance.payouts(organization_provider_account_id,organization_id) n",
  "finance.payment_provider_accounts <- finance.payouts(property_provider_account_id,property_id) n",
  "finance.payment_provider_accounts <- finance.provider_fee_evidence(provider_account_id,property_id,provider) r",
  "finance.payout_settings <- finance.payouts(payout_setting_id,organization_id) n",
  "finance.payout_settings <- finance.payouts(payout_setting_id,property_id) n",
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
  "identity.product_entitlements <- finance.billing_entitlements(identity_entitlement_id) n",
  // 0514 (VAY-2349): a removed user's notification read marks go with the user.
  "identity.users <- booking.host_notification_reads(user_id) c",
  "identity.users <- distribution.external_api_clients(created_by_user_id) n",
  "identity.users <- distribution.external_api_clients(revoked_by_user_id) n",
  "identity.users <- finance.commission_rate_changes(changed_by_user_id) n",
  "identity.users <- hotel_catalog.hotel_account_invites(created_by_user_id) n",
  "identity.users <- hotel_catalog.hotel_account_invites(redeemed_by_user_id) n",
  // 0503 (VAY-2247, live before W3): a removed user's own checklist view state goes with the user.
  "identity.users <- hotel_catalog.setup_checklist_viewer_states(user_id) c",
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
        const version = Number(name.slice(0, 4));
        // Production applies 0500 after 0503 and 0504, which were live before W3. It ran long before
        // 0529, which drops booking.pending_booking_edit_attempts, a table 0500 reads.
        if (version < MIGRATION || (version > 502 && version !== 529))
          await cp(join(MIGRATIONS, name), join(before, name));
        if (version === MIGRATION) file = name;
      }
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;
      // Checks and NOT NULL apply; replica mode only skips triggers and foreign-key checks.
      const write = (sql: string) =>
        db.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`);

      const references = await db.query<{ name: string }>(
        `SELECT c.confrelid::regclass::text || ' <- ' || c.conrelid::regclass::text || '(' ||
                (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) ||
                ') ' || c.confdeltype::text || CASE WHEN c.condeferred THEN ' deferred' ELSE '' END AS name
         FROM pg_catalog.pg_constraint c
         WHERE c.contype = 'f'
           AND c.confrelid IN ('identity.users'::regclass, 'identity.organizations'::regclass,
                               'identity.organization_memberships'::regclass,
                               'identity.product_entitlements'::regclass,
                               'platform.media_objects'::regclass,
                               'platform.media_upload_sessions'::regclass,
                               'finance.payout_settings'::regclass,
                               'finance.payment_provider_accounts'::regclass)
           AND (c.confdeltype IN ('c', 'n', 'd') OR c.condeferred
                OR c.confrelid IN ('finance.payout_settings'::regclass,
                                   'finance.payment_provider_accounts'::regclass))`,
      );
      expect(references.rows.map((row) => row.name).sort()).toEqual([...REFERENCES].sort());

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
                WHERE user_id IS NOT NULL OR organization_id IS NOT NULL) AS events,
               (SELECT count(*)::int FROM identity.user_consent_status) AS consents,
               (SELECT count(*)::int FROM identity.gdpr_requests) AS requests,
               (SELECT count(*)::int FROM platform.media_objects) AS media,
               (SELECT count(*)::int FROM platform.jobs WHERE status = 'pending') AS jobs,
               (SELECT count(*)::int FROM finance.payout_settings) AS "payoutSettings"`,
          )
        ).rows[0];
      const seeded = {
        organizations: 5,
        users: 7,
        memberships: 7,
        links: 2,
        identities: 3,
        events: 3,
        consents: 1,
        requests: 1,
        media: 3,
        jobs: 1,
        payoutSettings: 2,
      };
      expect(await state()).toEqual(seeded);

      // 0501 and 0502 may change what this checks, so it applies 0500 alone.
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
        payoutSettings: 1,
      });
      const blankOrganization = (organizationId: string) => ({
        id: organizationId,
        status: "archived",
        name: "Removed workspace",
        slug: `removed-${organizationId}`,
        website_url: null,
      });
      expect(
        (
          await db.query(
            `SELECT id::text, status, name, slug, website_url, workos_org_id FROM identity.organizations
             ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        { ...blankOrganization(CLOSED_ORG), workos_org_id: "org_closed_creator" },
        {
          id: PAYEE_ORG,
          status: "archived",
          name: "Paid affiliate",
          slug: "paid-affiliate",
          website_url: null,
          workos_org_id: null,
        },
        {
          id: HOTEL_ORG,
          status: "active",
          name: "Kept hotel",
          slug: "kept-hotel",
          website_url: null,
          workos_org_id: null,
        },
        { ...blankOrganization(FALLBACK_ORG), workos_org_id: null },
      ]);
      const blankUser = (userId: string) => ({
        id: userId,
        status: "deleted",
        email: `removed-${userId}@removed.invalid`,
        name: null,
        picture: null,
      });
      expect(
        (
          await db.query(
            `SELECT id::text, status, email, name, profile_picture_media_object_id AS picture
             FROM identity.users ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        blankUser(WORKOS_USER),
        blankUser(AUDITED_USER),
        {
          id: DUAL_USER,
          status: "active",
          email: "dual@example.test",
          name: "Dual Member",
          picture: HOTEL_MEDIA,
        },
        blankUser(INVITER_USER),
        blankUser(FALLBACK_USER),
      ]);
      // Blank rows keep their identities without details, so WorkOS still finds the closed account.
      // FALLBACK_USER became a blank row only in the one-by-one pass, so its identity is gone.
      expect(
        (
          await db.query(
            `SELECT user_id::text, provider_user_id, provider_email, provider_email_verified,
                    raw_profile, last_login_at
             FROM identity.external_identities ORDER BY user_id`,
          )
        ).rows,
      ).toEqual(
        [
          [WORKOS_USER, "user_workos_creator"],
          [AUDITED_USER, null],
        ].map(([userId, workosUserId]) => ({
          user_id: userId,
          provider_user_id: workosUserId,
          provider_email: null,
          provider_email_verified: false,
          raw_profile: null,
          last_login_at: null,
        })),
      );
      // The WorkOS markers stay without who they were about; the creation event goes.
      expect(
        (
          await db.query(
            `SELECT event_type, provider_event_id, user_id, organization_id, payload
             FROM identity.auth_reconciliation_events ORDER BY provider_event_id`,
          )
        ).rows,
      ).toEqual([
        {
          event_type: "workos.webhook.normalized",
          provider_event_id: "event_workos_creator",
          user_id: null,
          organization_id: null,
          payload: null,
        },
        {
          event_type: "workos.webhook.ignored",
          provider_event_id: "event_workos_workspace",
          user_id: null,
          organization_id: null,
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
               (SELECT count(*)::int FROM identity.product_entitlements) AS entitlements,
               (SELECT array_agg(product || ' ' || coalesce(identity_entitlement_id::text, 'unlinked')
                                 ORDER BY product)
                FROM finance.billing_entitlements) AS billing,
               (SELECT count(*)::int FROM finance.finance_visibility_read_model) AS visibility,
               (SELECT array_agg(id::text) FROM finance.payout_settings) AS "payoutSettings",
               (SELECT array_agg(id::text) FROM finance.payment_provider_accounts) AS "providerAccounts",
               (SELECT count(*)::int FROM finance.payouts) AS payouts,
               (SELECT count(*)::int FROM identity.consent_history) AS "consentHistory",
               (SELECT count(*)::int FROM identity.cookie_consents) AS cookies,
               (SELECT array_agg(id::text) FROM platform.media_objects) AS media,
               (SELECT count(*)::int FROM platform.media_variants) AS variants,
               (SELECT count(*)::int FROM platform.production_media_migration_items) AS "migrationItems",
               (SELECT count(*)::int FROM platform.media_upload_sessions) AS uploads,
               (SELECT array_agg(status) FROM platform.jobs) AS jobs,
               (SELECT array_agg(status) FROM platform.outbox_events) AS outbox,
               (SELECT array_agg(created_by_user_id::text) FROM hotel_catalog.hotel_account_invites) AS invites,
               (SELECT array_agg(creation_organization_id::text || ' ' || retired_by_user_id::text)
                FROM hotel_catalog.properties WHERE id = '${RETIRED_PROPERTY}') AS retired`,
          )
        ).rows,
      ).toEqual([
        {
          memberships: [`${HOTEL_ORG} hotel_owner`],
          links: ["booking"],
          entitlements: 0,
          billing: ["affiliate unlinked", "marketplace unlinked"],
          visibility: 0,
          payoutSettings: [KEPT_SETTING],
          providerAccounts: [KEPT_ACCOUNT],
          payouts: 1,
          consentHistory: 0,
          cookies: 0,
          media: [HOTEL_MEDIA],
          variants: 0,
          migrationItems: 0,
          uploads: 0,
          jobs: ["canceled"],
          outbox: ["canceled"],
          // A set-null column would have lost the inviter; the user stays as a blank row instead.
          invites: [INVITER_USER],
          retired: [`${FALLBACK_ORG} ${FALLBACK_USER}`],
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
