import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_MEDIA_CLEANUP_QUEUE,
  buildPlatformMediaCleanupJobKey,
  createPgPlatformMediaCleanupStore,
  runPlatformMediaCleanupJobs,
} from "./platformMediaCleanup.js";

const URL = process.env["TEST_DATABASE_URL"];
const SESSION = "20820000-0000-4000-8000-000000000001";
const LEGACY_SESSION = "20820000-0000-4000-8000-000000000002";
const MEDIA = "20820000-0000-4000-8000-000000000003";
const IDS = [SESSION, LEGACY_SESSION, MEDIA].map((id) => `'${id}'`).join(",");
// VAY-2272 retired-media purge fixtures.
const id = (n: number) => `22720000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CREATOR_ORG, HOTEL_ORG, CREATOR_USER, DUAL_USER, CREATED_AS_CREATOR, PROPERTY] = [
  1, 2, 3, 4, 5, 6,
].map(id);
const [CREATOR_PHOTO, CHAT_FILE, LEGACY_TYPE_PHOTO, DUAL_PHOTO, HOTEL_USED, EXTERNAL, MARKED] = [
  11, 12, 13, 14, 15, 16, 17,
].map(id);
// Each in the set through one branch only: owner workspace, creator membership (also the removed
// creator's own avatar); a kept user's avatar and a hotel add-on photo stay in use.
const [OWNED_ONLY, CREATED_ONLY, KEPT_AVATAR, ADDON_PHOTO] = [18, 19, 20, 21].map(id);
const PURGE_MEDIA = [
  CREATOR_PHOTO,
  CHAT_FILE,
  LEGACY_TYPE_PHOTO,
  DUAL_PHOTO,
  HOTEL_USED,
  EXTERNAL,
  MARKED,
  OWNED_ONLY,
  CREATED_ONLY,
  KEPT_AVATAR,
  ADDON_PHOTO,
];
const PURGE_IDS = PURGE_MEDIA.map((value) => `'${value}'`).join(",");
// Dated long before any other suite's rows, so these runs select only their own. A cleanup run
// from another suite at a later "now" would select these rows, so CI runs this file on its own.
const EXPIRES_AT = "2001-01-01T00:00:00.000Z";
const NOW = new Date("2001-01-01T00:15:00.000Z");
const minutesAfterNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL platform media cleanup", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const deleteObject = vi.fn(async () => undefined);
  const store = createPgPlatformMediaCleanupStore({
    connectionString: URL ?? "postgresql://disabled",
    objectDeleter: { deleteObject },
  });

  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await cleanupPurge();
  });

  afterAll(async () => {
    await cleanup();
    await cleanupPurge();
    await store.close();
    await admin.end();
  });

  it("expires an abandoned upload session without touching storage", async () => {
    await admin.query(
      `INSERT INTO platform.media_upload_sessions
         (id, upload_session_key, requested_purpose, requested_visibility, resource_product,
          resource_type, staging_prefix, expires_at, session_status)
       VALUES ($1::uuid, 'media.upload_session:' || $1, 'identity.user.profile_image', 'private',
               'platform', 'user', 'staging/' || $1, $2::timestamptz, 'signed')`,
      [SESSION, EXPIRES_AT],
    );

    const first = await runPlatformMediaCleanupJobs(store, {
      now: NOW,
      run: ["abandonedStagingUploads"],
    });
    const rerun = await runPlatformMediaCleanupJobs(store, {
      now: NOW,
      run: ["abandonedStagingUploads"],
    });

    expect(first).toMatchObject({ scanned: 1, applied: 1, failed: 0 });
    expect(rerun).toMatchObject({ scanned: 0, failed: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(
      (
        await admin.query(
          `SELECT session.session_status, session.failure_reason, job.job_type, job.status, job.resource_type
           FROM platform.media_upload_sessions session
           JOIN platform.jobs job ON job.queue_name = $2 AND job.resource_id = session.id::text
           WHERE session.id = $1::uuid`,
          [SESSION, PLATFORM_MEDIA_CLEANUP_QUEUE],
        )
      ).rows,
    ).toEqual([
      {
        session_status: "expired",
        failure_reason: "abandoned_staging_upload_cleanup",
        job_type: "platform.media.cleanup.abandoned-staging-upload",
        status: "succeeded",
        resource_type: "media_upload_session",
      },
    ]);
  });

  it("backs off a failing item, dead-letters it once at the cap and then leaves it alone", async () => {
    await admin.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, visibility, purpose, resource_product, resource_type, resource_id,
          lifecycle_status, retained_until)
       VALUES ($1::uuid, 'test-private', 'private/chat/' || $1 || '.webp', 'private',
               'pms.messaging.attachment', 'pms', 'message_thread',
               'thread-vay2082', 'active', $2::timestamptz)`,
      [MEDIA, EXPIRES_AT],
    );
    const denied = Object.assign(new Error("not authorized to perform s3:DeleteObject"), {
      name: "AccessDenied",
    });
    const failing = createPgPlatformMediaCleanupStore({
      connectionString: URL!,
      objectDeleter: { deleteObject: vi.fn(async () => Promise.reject(denied)) },
    });
    const runAt = (now: Date) =>
      runPlatformMediaCleanupJobs(failing, { now, run: ["privateAttachmentRetention"] });
    const deadLetters = async () =>
      (
        await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM platform.dead_letter_events WHERE resource_id = $1",
          [MEDIA],
        )
      ).rows[0]!.count;

    try {
      // Attempt n runs once the back-off after attempt n-1 (15 min, 1 h, 4 h, 24 h) has passed.
      const attemptTimes = [0, 15, 75, 315, 1755].map(minutesAfterNow);
      for (const [index, now] of attemptTimes.entries()) {
        if (index > 0) {
          const early = await runAt(new Date(now.getTime() - 1));
          expect(early).toMatchObject({ scanned: 0, failed: 0 });
        }
        const result = await runAt(now);
        expect(result).toMatchObject({ scanned: 1, failed: 1 });
        expect(result.runs[0]!.failures[0]).toMatchObject({
          resourceId: MEDIA,
          reasonCode: "media_storage_delete_failed",
          errorCode: "AccessDenied",
          attempt: index + 1,
          deadLettered: index === 4,
        });
        expect(await deadLetters()).toBe(index === 4 ? 1 : 0);
        if (index === 0 || index === 4) {
          // A second API task that selected the item before this attempt was recorded.
          const late = await failing.recordCleanupFailure(
            {
              mediaObjectId: MEDIA,
              resourceProduct: "pms",
              resourceType: "message_thread",
              resourceId: "thread-vay2082",
              lifecycleStatus: "active",
              retainedUntil: EXPIRES_AT,
            },
            {
              action: "delete-private-attachment-after-retention",
              runName: "privateAttachmentRetention",
              jobType: "platform.media.cleanup.private-attachment-retention",
              eventType: "platform_media.private_attachment.deleted_after_retention",
              auditAction: "platform_media.cleanup.private_attachment_deleted_after_retention",
              deadlineOrWindow: EXPIRES_AT,
            },
            denied,
            { now, correlationId: "vay2082-late-runner", workerId: "late-runner" },
          );
          expect(late).toMatchObject({ attempt: index + 1, deadLettered: false });
          expect(await deadLetters()).toBe(index === 4 ? 1 : 0);
        }
      }
      const muchLater = await runAt(minutesAfterNow(100 * 24 * 60));

      expect(muchLater).toMatchObject({ scanned: 0, failed: 0 });
      expect(await deadLetters()).toBe(1);
      expect(
        (
          await admin.query(
            `SELECT job.status, job.attempts_count, job.max_attempts,
                    job.job_metadata ->> 'retryPolicy' AS policy,
                    job.job_metadata ->> 'errorCode' AS code,
                    (SELECT count(*)::int FROM platform.job_attempts attempt WHERE attempt.job_id = job.id) AS attempts,
                    media.lifecycle_status
             FROM platform.jobs job
             JOIN platform.media_objects media ON media.id::text = job.resource_id
             WHERE job.queue_name = $2 AND job.resource_id = $1`,
            [MEDIA, PLATFORM_MEDIA_CLEANUP_QUEUE],
          )
        ).rows,
      ).toEqual([
        {
          status: "dead_lettered",
          attempts_count: 5,
          max_attempts: 5,
          policy: "bounded.v1",
          code: "AccessDenied",
          attempts: 5,
          lifecycle_status: "active",
        },
      ]);
    } finally {
      await failing.close();
    }
  });

  it("retries a dead letter left by the old recorder and resolves it on success", async () => {
    await admin.query(
      `INSERT INTO platform.media_upload_sessions
         (id, upload_session_key, requested_purpose, requested_visibility, resource_product,
          resource_type, staging_prefix, expires_at, session_status)
       VALUES ($1::uuid, 'media.upload_session:' || $1, 'identity.user.profile_image', 'private',
               'platform', 'user', 'staging/' || $1, $2::timestamptz, 'uploaded')`,
      [LEGACY_SESSION, EXPIRES_AT],
    );
    // The old recorder: one dead-lettered job (1 of 1 attempts, no retry policy) and a new open
    // dead letter on every run.
    const legacyJob = (
      await admin.query<{ id: string }>(
        `INSERT INTO platform.jobs
           (job_key, queue_name, job_type, status, attempts_count, max_attempts, run_after,
            finished_at, resource_product, resource_type, resource_id, job_metadata)
         VALUES ($1, $2, 'platform.media.cleanup.abandoned-staging-upload', 'dead_lettered', 1, 1,
                 $3::timestamptz, $3::timestamptz, 'platform', 'media_upload_session', $4,
                 '{"errorType":"PlatformMediaStorageDeleteError"}'::jsonb)
         RETURNING id`,
        [
          buildPlatformMediaCleanupJobKey({
            action: "abandoned-staging-upload",
            resourceId: LEGACY_SESSION,
            deadlineOrWindow: EXPIRES_AT,
          }),
          PLATFORM_MEDIA_CLEANUP_QUEUE,
          EXPIRES_AT,
          LEGACY_SESSION,
        ],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO platform.job_attempts (job_id, attempt_number, status, started_at, finished_at)
       VALUES ($1::uuid, 1, 'failed', $2::timestamptz, $2::timestamptz)`,
      [legacyJob, EXPIRES_AT],
    );
    await admin.query(
      `INSERT INTO platform.dead_letter_events
         (source_kind, job_id, resource_product, resource_type, resource_id, reason_code, failure_summary)
       SELECT 'job', $1::uuid, 'platform', 'media_upload_session', $2, 'media_storage_delete_failed', 'legacy'
       FROM generate_series(1, 2)`,
      [legacyJob, LEGACY_SESSION],
    );

    const result = await runPlatformMediaCleanupJobs(store, {
      now: NOW,
      run: ["abandonedStagingUploads"],
    });

    expect(result).toMatchObject({ failed: 0 });
    expect(result.runs[0]!.mutations).toContainEqual(
      expect.objectContaining({ resourceId: LEGACY_SESSION, applied: true }),
    );
    expect(
      (
        await admin.query(
          `SELECT session.session_status, job.status, job.attempts_count,
                  (SELECT array_agg(attempt.status ORDER BY attempt.attempt_number)
                   FROM platform.job_attempts attempt WHERE attempt.job_id = job.id) AS attempts,
                  (SELECT array_agg(DISTINCT dead.recovery_status)
                   FROM platform.dead_letter_events dead WHERE dead.job_id = job.id) AS dead_letters
           FROM platform.media_upload_sessions session
           JOIN platform.jobs job ON job.id = $2::uuid
           WHERE session.id = $1::uuid`,
          [LEGACY_SESSION, legacyJob],
        )
      ).rows,
    ).toEqual([
      {
        session_status: "expired",
        status: "succeeded",
        attempts_count: 2,
        attempts: ["failed", "succeeded"],
        dead_letters: ["resolved"],
      },
    ]);
  });

  it("purges retired Marketplace and creator media files and leaves everything else (VAY-2272)", async () => {
    await seedRetiredMedia();
    const deleteRetired = vi.fn(
      async (_input: { bucket: string; storageKey: string }) => undefined,
    );
    const invalidatePublicObjects = vi.fn(async (_keys: readonly string[]) => ({
      invalidationId: "IPURGETEST",
    }));
    const purging = createPgPlatformMediaCleanupStore({
      connectionString: URL!,
      objectDeleter: { deleteObject: deleteRetired },
      cdnInvalidator: { invalidatePublicObjects, close: vi.fn() },
    });
    const purge = () =>
      runPlatformMediaCleanupJobs(purging, {
        now: NOW,
        limit: 500,
        run: ["retiredMarketplacePurge"],
      });

    try {
      const first = await purge();
      const rerun = await purge();

      const applied = (run: typeof first) =>
        run.runs[0]!.mutations.filter((mutation) => mutation.applied).map((m) => m.resourceId);
      expect(first.runs[0]!.failures).toEqual([]);
      expect(applied(first)).toEqual(
        expect.arrayContaining([
          CREATOR_PHOTO,
          CHAT_FILE,
          LEGACY_TYPE_PHOTO,
          OWNED_ONLY,
          CREATED_ONLY,
        ]),
      );
      for (const kept of [DUAL_PHOTO, HOTEL_USED, EXTERNAL, MARKED, KEPT_AVATAR, ADDON_PHOTO])
        expect(applied(first)).not.toContain(kept);
      expect(first.runs[0]!.blocked).toEqual(
        expect.arrayContaining([HOTEL_USED, KEPT_AVATAR, ADDON_PHOTO]),
      );
      const reselected = rerun.runs[0]!.mutations.map((mutation) => mutation.resourceId);
      for (const purged of [CREATOR_PHOTO, CHAT_FILE, LEGACY_TYPE_PHOTO, OWNED_ONLY, CREATED_ONLY])
        expect(reselected).not.toContain(purged);

      const deletedKeys = deleteRetired.mock.calls.map(([input]) => input.storageKey);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          `private/media/${CREATOR_PHOTO}/original/image.jpg`,
          `public/media/${CREATOR_PHOTO}/original_safe/v1.webp`,
          `public/media/${CREATOR_PHOTO}/thumbnail/v1.webp`,
          `private/media/${CHAT_FILE}/original/file.pdf`,
          `private/media/${LEGACY_TYPE_PHOTO}/original/image.jpg`,
        ]),
      );
      for (const kept of [DUAL_PHOTO, HOTEL_USED, MARKED, KEPT_AVATAR, ADDON_PHOTO])
        expect(deletedKeys.filter((key) => key.includes(kept))).toEqual([]);
      expect(invalidatePublicObjects.mock.calls.map(([keys]) => keys)).toContainEqual([
        `public/media/${CREATOR_PHOTO}/original_safe/v1.webp`,
        `public/media/${CREATOR_PHOTO}/thumbnail/v1.webp`,
      ]);

      const rows = await admin.query<{
        id: string;
        lifecycle_status: string;
        visibility: string;
        purged_at: string | null;
        invalidation_id: string | null;
      }>(
        `SELECT id::text, lifecycle_status, visibility,
                source_metadata ->> 'retiredPurgeCompletedAt' AS purged_at,
                source_metadata ->> 'retiredPurgeInvalidationId' AS invalidation_id
         FROM platform.media_objects WHERE id IN (${PURGE_IDS}) ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        {
          id: CREATOR_PHOTO,
          lifecycle_status: "active",
          visibility: "public",
          purged_at: NOW.toISOString(),
          invalidation_id: "IPURGETEST",
        },
        {
          id: CHAT_FILE,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: NOW.toISOString(),
          invalidation_id: null,
        },
        {
          id: LEGACY_TYPE_PHOTO,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: NOW.toISOString(),
          invalidation_id: null,
        },
        {
          id: DUAL_PHOTO,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: null,
          invalidation_id: null,
        },
        {
          id: HOTEL_USED,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: null,
          invalidation_id: null,
        },
        {
          id: EXTERNAL,
          lifecycle_status: "external_reference",
          visibility: "private",
          purged_at: null,
          invalidation_id: null,
        },
        {
          id: MARKED,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: "2001-01-01T00:00:00.000Z",
          invalidation_id: null,
        },
        ...[OWNED_ONLY, CREATED_ONLY].map((purged) => ({
          id: purged,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: NOW.toISOString(),
          invalidation_id: null,
        })),
        ...[KEPT_AVATAR, ADDON_PHOTO].map((inUse) => ({
          id: inUse,
          lifecycle_status: "active",
          visibility: "private",
          purged_at: null,
          invalidation_id: null,
        })),
      ]);
      expect(
        (
          await admin.query(
            `SELECT DISTINCT job_type, status, tenant_scope, organization_id, property_id
             FROM platform.jobs WHERE queue_name = $1 AND resource_id IN (${PURGE_IDS})`,
            [PLATFORM_MEDIA_CLEANUP_QUEUE],
          )
        ).rows,
      ).toEqual([
        {
          job_type: "platform.media.cleanup.retired-marketplace-purge",
          status: "succeeded",
          tenant_scope: "platform",
          organization_id: null,
          property_id: null,
        },
      ]);
    } finally {
      await purging.close();
    }
  });

  async function seedRetiredMedia() {
    // Constraints and checks apply; replica mode only skips the triggers of unrelated domains.
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO identity.organizations (id, kind, name, slug) VALUES
        ('${CREATOR_ORG}', 'creator_workspace', 'VAY-2272 creator', 'vay-2272-creator'),
        ('${HOTEL_ORG}', 'hotel_group', 'VAY-2272 hotel', 'vay-2272-hotel');
      INSERT INTO identity.users (id, email) VALUES
        ('${CREATOR_USER}', 'vay-2272-creator@example.test'),
        ('${DUAL_USER}', 'vay-2272-dual@example.test'),
        ('${CREATED_AS_CREATOR}', 'vay-2272-legacy-type@example.test');
      INSERT INTO identity.organization_memberships
        (organization_id, user_id, role_key, access_origin, property_access_mode) VALUES
        ('${CREATOR_ORG}', '${CREATOR_USER}', 'creator_owner', 'agency', 'all'),
        ('${CREATOR_ORG}', '${DUAL_USER}', 'creator_owner', 'agency', 'all'),
        ('${HOTEL_ORG}', '${DUAL_USER}', 'hotel_owner', 'agency', 'all');
      INSERT INTO identity.auth_reconciliation_events (event_type, provider, user_id, payload) VALUES
        ('identity.user.created', 'workos', '${CREATED_AS_CREATOR}',
         '{"payload": {"legacyUserType": "creator"}}'::jsonb);
      INSERT INTO hotel_catalog.properties (id, public_id, display_name, creation_organization_id)
        VALUES ('${PROPERTY}', '${PROPERTY}', 'VAY-2272 hotel', '${HOTEL_ORG}');
      INSERT INTO platform.media_objects
        (id, bucket, storage_key, storage_kind, visibility, purpose, owner_organization_id,
         property_id, resource_product, resource_type, resource_id, lifecycle_status,
         public_approved, source_url, created_by_user_id, source_metadata, created_at) VALUES
        ('${CREATOR_PHOTO}', 'test-media', 'private/media/${CREATOR_PHOTO}/original/image.jpg',
         'vayada_managed', 'public', 'marketplace.creator.profile_image', '${CREATOR_ORG}', NULL,
         'marketplace', 'creator_profile', 'creator-vay2272', 'active', TRUE, NULL, NULL, '{}',
         '2000-12-31T00:00:00Z'),
        ('${CHAT_FILE}', 'test-media', 'private/media/${CHAT_FILE}/original/file.pdf',
         'vayada_managed', 'private', 'marketplace.collaboration_chat.attachment', NULL, NULL,
         'marketplace', 'collaboration', 'collaboration-vay2272', 'active', FALSE, NULL,
         '${CREATOR_USER}', '{}', '2000-12-31T00:00:00Z'),
        ('${LEGACY_TYPE_PHOTO}', 'test-media', 'private/media/${LEGACY_TYPE_PHOTO}/original/image.jpg',
         'vayada_managed', 'private', 'identity.user.profile_image', NULL, NULL,
         'platform', 'user', '${CREATED_AS_CREATOR}', 'active', FALSE, NULL,
         '${CREATED_AS_CREATOR}', '{}', '2000-12-31T00:00:00Z'),
        ('${DUAL_PHOTO}', 'test-media', 'private/media/${DUAL_PHOTO}/original/image.jpg',
         'vayada_managed', 'private', 'identity.user.profile_image', '${HOTEL_ORG}', NULL,
         'platform', 'user', '${DUAL_USER}', 'active', FALSE, NULL, '${DUAL_USER}', '{}',
         '2000-12-31T00:00:00Z'),
        ('${HOTEL_USED}', 'test-media', 'private/media/${HOTEL_USED}/original/image.jpg',
         'vayada_managed', 'private', 'marketplace.offer.media', '${CREATOR_ORG}', '${PROPERTY}',
         'marketplace', 'marketplace_offer', 'offer-vay2272', 'active', FALSE, NULL, NULL, '{}',
         '2000-12-31T00:00:00Z'),
        ('${EXTERNAL}', NULL, NULL, 'external_reference', 'private', 'marketplace.offer.media',
         '${CREATOR_ORG}', NULL, 'marketplace', 'marketplace_offer', 'offer-vay2272-legacy',
         'external_reference', FALSE, 'https://legacy.example.test/offer.jpg', NULL, '{}',
         '2000-12-31T00:00:00Z'),
        ('${OWNED_ONLY}', 'test-media', 'private/media/${OWNED_ONLY}/original/image.jpg',
         'vayada_managed', 'private', 'identity.user.profile_image', '${CREATOR_ORG}', NULL,
         'platform', 'user', 'owned-only-vay2272', 'active', FALSE, NULL, NULL, '{}',
         '2000-12-31T00:00:00Z'),
        ('${CREATED_ONLY}', 'test-media', 'private/media/${CREATED_ONLY}/original/image.jpg',
         'vayada_managed', 'private', 'identity.user.profile_image', NULL, NULL,
         'platform', 'user', '${CREATOR_USER}', 'active', FALSE, NULL, '${CREATOR_USER}', '{}',
         '2000-12-31T00:00:00Z'),
        ('${KEPT_AVATAR}', 'test-media', 'private/media/${KEPT_AVATAR}/original/image.jpg',
         'vayada_managed', 'private', 'identity.user.profile_image', '${CREATOR_ORG}', NULL,
         'platform', 'user', '${DUAL_USER}', 'active', FALSE, NULL, '${DUAL_USER}', '{}',
         '2000-12-31T00:00:00Z'),
        ('${ADDON_PHOTO}', 'test-media', 'private/media/${ADDON_PHOTO}/original/image.jpg',
         'vayada_managed', 'private', 'booking.addon.image', '${CREATOR_ORG}', '${PROPERTY}',
         'booking', 'addon', 'addon-vay2272', 'active', FALSE, NULL, NULL, '{}',
         '2000-12-31T00:00:00Z'),
        ('${MARKED}', 'test-media', 'private/media/${MARKED}/original/image.jpg',
         'vayada_managed', 'private', 'marketplace.offer.media', '${CREATOR_ORG}', NULL,
         'marketplace', 'marketplace_offer', 'offer-vay2272-marked', 'active', FALSE, NULL, NULL,
         '{"retiredPurgeCompletedAt": "2001-01-01T00:00:00.000Z"}', '2000-12-31T00:00:00Z');
      INSERT INTO platform.media_variants
        (media_object_id, variant_name, visibility, storage_key, content_type, size_bytes, public_cdn_url) VALUES
        ('${CREATOR_PHOTO}', 'original_safe', 'public', 'public/media/${CREATOR_PHOTO}/original_safe/v1.webp',
         'image/webp', 10, 'https://cdn.example.test/media/${CREATOR_PHOTO}/original_safe/v1.webp'),
        ('${CREATOR_PHOTO}', 'thumbnail', 'public', 'public/media/${CREATOR_PHOTO}/thumbnail/v1.webp',
         'image/webp', 10, 'https://cdn.example.test/media/${CREATOR_PHOTO}/thumbnail/v1.webp');
      UPDATE identity.users SET profile_picture_media_object_id = upper('${KEPT_AVATAR}')
        WHERE id = '${DUAL_USER}';
      UPDATE identity.users SET profile_picture_media_object_id = upper('${CREATED_ONLY}')
        WHERE id = '${CREATOR_USER}';
      INSERT INTO booking.addon_definitions (property_id, name, pricing_model, currency, metadata)
        VALUES ('${PROPERTY}', 'VAY-2272 breakfast', 'per_stay', 'EUR',
                '{"photos": [{"mediaObjectId": "${ADDON_PHOTO}", "imageUrl": "x", "isCover": true}]}');
      INSERT INTO hotel_catalog.property_media
        (property_id, media_type, url, source_system, platform_media_object_id) VALUES
        ('${PROPERTY}', 'gallery_image', 'https://cdn.example.test/hotel.webp', 'platform', '${HOTEL_USED}');
      COMMIT`);
  }

  async function cleanupPurge() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE target_resource_id IN (${PURGE_IDS});
      DELETE FROM platform.dead_letter_events WHERE resource_id IN (${PURGE_IDS});
      DELETE FROM platform.job_attempts WHERE job_id IN
        (SELECT id FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id IN (${PURGE_IDS}));
      DELETE FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id IN (${PURGE_IDS});
      DELETE FROM platform.domain_events WHERE source_system='platform' AND resource_id IN (${PURGE_IDS});
      DELETE FROM platform.idempotency_keys WHERE response_resource_id IN (${PURGE_IDS});
      DELETE FROM hotel_catalog.property_media WHERE property_id = '${PROPERTY}';
      DELETE FROM booking.addon_definitions WHERE property_id = '${PROPERTY}';
      DELETE FROM platform.media_variants WHERE media_object_id IN (${PURGE_IDS});
      DELETE FROM platform.media_objects WHERE id IN (${PURGE_IDS});
      DELETE FROM hotel_catalog.properties WHERE id = '${PROPERTY}';
      DELETE FROM identity.auth_reconciliation_events WHERE user_id = '${CREATED_AS_CREATOR}';
      DELETE FROM identity.organization_memberships WHERE organization_id IN ('${CREATOR_ORG}', '${HOTEL_ORG}');
      DELETE FROM identity.users WHERE id IN ('${CREATOR_USER}', '${DUAL_USER}', '${CREATED_AS_CREATOR}');
      DELETE FROM identity.organizations WHERE id IN ('${CREATOR_ORG}', '${HOTEL_ORG}'); COMMIT`);
  }

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE target_resource_id IN (${IDS});
      DELETE FROM platform.dead_letter_events WHERE resource_id IN (${IDS});
      DELETE FROM platform.job_attempts WHERE job_id IN
        (SELECT id FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id IN (${IDS}));
      DELETE FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id IN (${IDS});
      DELETE FROM platform.domain_events WHERE source_system='platform' AND resource_id IN (${IDS});
      DELETE FROM platform.idempotency_keys WHERE response_resource_id IN (${IDS});
      DELETE FROM platform.media_objects WHERE id IN (${IDS});
      DELETE FROM platform.media_upload_sessions WHERE id IN (${IDS}); COMMIT`);
  }
});
