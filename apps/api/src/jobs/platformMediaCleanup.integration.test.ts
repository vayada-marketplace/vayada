import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_MEDIA_CLEANUP_QUEUE,
  createPgPlatformMediaCleanupStore,
  runPlatformMediaCleanupJobs,
} from "./platformMediaCleanup.js";

const URL = process.env["TEST_DATABASE_URL"];
const SESSION = "20820000-0000-4000-8000-000000000001";
// Dated long before any other suite's rows, so these runs select only their own. A cleanup run
// from another suite at a later "now" would select these rows, so CI runs this file on its own.
const EXPIRES_AT = "2001-01-01T00:00:00.000Z";
const NOW = new Date("2001-01-01T00:15:00.000Z");
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

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE target_resource_id='${SESSION}';
      DELETE FROM platform.dead_letter_events WHERE resource_id='${SESSION}';
      DELETE FROM platform.job_attempts WHERE job_id IN
        (SELECT id FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id='${SESSION}');
      DELETE FROM platform.jobs WHERE queue_name='${PLATFORM_MEDIA_CLEANUP_QUEUE}' AND resource_id='${SESSION}';
      DELETE FROM platform.domain_events WHERE source_system='platform' AND resource_id='${SESSION}';
      DELETE FROM platform.idempotency_keys WHERE response_resource_id='${SESSION}';
      DELETE FROM platform.media_upload_sessions WHERE id='${SESSION}'; COMMIT`);
  }
});
