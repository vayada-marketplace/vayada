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
// Long before any other suite's sessions, so this run only ever selects its own rows.
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
  });

  afterAll(async () => {
    await cleanup();
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
               'marketplace.collaboration_chat.attachment', 'marketplace', 'collaboration',
               'collaboration-vay2082', 'active', $2::timestamptz)`,
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
