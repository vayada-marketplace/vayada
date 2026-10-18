import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import type { BookingEmailDelivery } from "./jobs/bookingEmailDelivery.js";
import {
  createPgContactIntakeRetentionStore,
  type ContactIntakeRetentionStore,
} from "./jobs/contactIntakeRetention.js";
import { runContactNotificationJobs } from "./jobs/contactNotificationDelivery.js";
import {
  createPgPlatformContactIntakeRepository,
  type PlatformContactIntakePayload,
  type PlatformContactIntakeRepository,
} from "./routes/platformContactIntake.js";

// VAY-2286: what a contact message leaves behind, as the production-shaped API login.
const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

function contactPayload(marker: string): PlatformContactIntakePayload {
  return {
    name: `Ana Host ${marker}`,
    email: `ana.${marker}@example.com`,
    phone: `+351 ${marker}`,
    company: `Casa ${marker}`,
    country: `Portugal ${marker}`,
    userType: "hotel",
    message: `We have 12 rooms ${marker}`,
  };
}

describe.skipIf(!URL)("PostgreSQL contact intake storage, delivery and retention", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  let login: HotelSetupOrdinaryLoginFixture;
  let repository: PlatformContactIntakeRepository;
  let retention: ContactIntakeRetentionStore;

  const submit = (marker: string, channel: "contact_form" | "in_app_support" = "contact_form") =>
    repository.submitContact({
      payload: contactPayload(marker),
      channel,
      // Like Fastify's request ids: never personal, and kept apart from the marker search.
      requestId: `req-${randomUUID()}`,
      receivedAt: new Date().toISOString(),
    });

  /** Every platform row that mentions the marker, as text. */
  const rowsMentioning = async (marker: string) => {
    const result = await admin.query<{ source: string }>(
      `SELECT 'domain_events' AS source FROM platform.domain_events t WHERE t::text LIKE $1
       UNION ALL SELECT 'product_audit_events' FROM platform.product_audit_events t WHERE t::text LIKE $1
       UNION ALL SELECT 'jobs' FROM platform.jobs t WHERE t::text LIKE $1
       UNION ALL SELECT 'job_attempts' FROM platform.job_attempts t WHERE t::text LIKE $1
       UNION ALL SELECT 'dead_letter_events' FROM platform.dead_letter_events t WHERE t::text LIKE $1`,
      [`%${marker}%`],
    );
    return result.rows.map((row) => row.source).sort();
  };

  beforeAll(async () => {
    await admin.connect();
    login = await createHotelSetupOrdinaryLoginFixture(admin, URL!);
    repository = createPgPlatformContactIntakeRepository({
      connectionString: login.connectionString,
    });
    retention = createPgContactIntakeRetentionStore({ connectionString: login.connectionString });
  }, 60_000);

  afterAll(async () => {
    await repository?.close?.();
    await retention?.close();
    await login?.drop();
    await admin.end();
  });

  it("keeps the visitor's details only in the deletable job row", async () => {
    const marker = randomUUID().slice(0, 8);

    const accepted = await submit(marker);

    // Name, address, phone, company, country and message: only the job row has any of them.
    expect(await rowsMentioning(marker)).toEqual(["jobs"]);
    const job = await admin.query(
      "SELECT queue_name, job_type, payload, job_metadata, status FROM platform.jobs WHERE id=$1",
      [accepted.jobId],
    );
    expect(job.rows[0]).toMatchObject({
      queue_name: "platform.email",
      job_type: "email.platform-contact-notification",
      payload: contactPayload(marker),
      job_metadata: { channel: "contact_form" },
      status: "pending",
    });
    const event = await admin.query(
      "SELECT payload FROM platform.domain_events WHERE id=$1::uuid",
      [accepted.eventId],
    );
    expect(event.rows[0]?.payload).toEqual({ channel: "contact_form" });
    const audit = await admin.query(
      `SELECT redacted_payload, private_payload FROM platform.product_audit_events
       WHERE job_id=$1::uuid AND action='platform.contact_submission.received'`,
      [accepted.jobId],
    );
    expect(audit.rows).toEqual([
      { redacted_payload: { channel: "contact_form", outcome: "accepted" }, private_payload: {} },
    ]);
    // The email is stored lower-case; that form doesn't reach the append-only tables either.
    expect(await rowsMentioning(`ana.${marker}@example.com`.toLowerCase())).toEqual(["jobs"]);
  });

  /** Earlier tests (and suites) may leave contact jobs queued; only this test's jobs may run. */
  const parkOtherContactJobs = () =>
    admin.query(
      `UPDATE platform.jobs SET run_after = now() + interval '1 day'
       WHERE job_type = 'email.platform-contact-notification' AND status = 'pending'`,
    );

  it("emails contact-form messages to the recipient with the visitor as Reply-To", async () => {
    await parkOtherContactJobs();
    const marker = randomUUID().slice(0, 8);
    const support = randomUUID().slice(0, 8);
    const form = await submit(marker);
    const supportJob = await submit(support, "in_app_support");
    const sent: Parameters<BookingEmailDelivery["send"]>[0][] = [];

    const result = await runContactNotificationJobs(
      login.connectionString,
      { send: async (input) => void sent.push(input) },
      { recipient: "team@example.test" },
    );

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "team@example.test",
      replyTo: `ana.${marker}@example.com`,
      subject: `Contact form: Ana Host ${marker}`,
    });
    for (const line of [
      `Email: ana.${marker}@example.com`,
      `Phone: +351 ${marker}`,
      `Company: Casa ${marker}`,
      `We have 12 rooms ${marker}`,
    ])
      expect(sent[0]?.text).toContain(line);
    const jobs = await admin.query<{ id: string; status: string }>(
      "SELECT id::text, status FROM platform.jobs WHERE id = ANY($1::uuid[])",
      [[form.jobId, supportJob.jobId]],
    );
    expect(Object.fromEntries(jobs.rows.map((row) => [row.id, row.status]))).toEqual({
      [form.jobId]: "succeeded",
      [supportJob.jobId]: "pending",
    });
    const audit = await admin.query(
      "SELECT action, redacted_payload, private_payload FROM platform.product_audit_events WHERE job_id=$1::uuid ORDER BY recorded_at",
      [form.jobId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "platform.contact_submission.received",
      "platform.contact_notification.delivery_succeeded",
    ]);
    expect(audit.rows[1]).toMatchObject({
      redacted_payload: { outcome: "succeeded", attemptNumber: 1 },
      private_payload: {},
    });
    expect(await rowsMentioning(marker)).toEqual(["jobs"]);
  });

  it("retries a failed send later and records no personal data about it", async () => {
    await parkOtherContactJobs();
    const marker = randomUUID().slice(0, 8);
    const form = await submit(marker);

    const result = await runContactNotificationJobs(
      login.connectionString,
      {
        send: async (input) => {
          throw new Error(`provider refused ${input.replyTo}`);
        },
      },
      { recipient: "team@example.test" },
    );

    expect(result).toEqual({ processed: 0, failed: 1 });
    const job = await admin.query(
      "SELECT status, attempts_count, run_after > now() AS later FROM platform.jobs WHERE id=$1::uuid",
      [form.jobId],
    );
    expect(job.rows[0]).toEqual({ status: "pending", attempts_count: 1, later: true });
    const attempt = await admin.query(
      "SELECT status, error_message FROM platform.job_attempts WHERE job_id=$1::uuid",
      [form.jobId],
    );
    expect(attempt.rows).toEqual([
      { status: "failed", error_message: "Contact notification delivery failed." },
    ]);
    expect(await rowsMentioning(marker)).toEqual(["jobs"]);
  });

  it("empties messages after 90 days, cancels unsent ones and keeps younger ones", async () => {
    const old = randomUUID().slice(0, 8);
    const oldSupport = randomUUID().slice(0, 8);
    const young = randomUUID().slice(0, 8);
    const oldJob = await submit(old);
    const oldSupportJob = await submit(oldSupport, "in_app_support");
    const youngJob = await submit(young);
    await admin.query(
      `UPDATE platform.jobs SET created_at = now() - interval '91 days',
         status = CASE WHEN id = $2::uuid THEN 'succeeded' ELSE status END,
         finished_at = CASE WHEN id = $2::uuid THEN now() - interval '91 days' END
       WHERE id = ANY($1::uuid[])`,
      [[oldJob.jobId, oldSupportJob.jobId], oldSupportJob.jobId],
    );
    await admin.query(
      "UPDATE platform.jobs SET created_at = now() - interval '89 days' WHERE id=$1::uuid",
      [youngJob.jobId],
    );

    expect(await retention.purgeExpiredBatch(new Date(), 500)).toBeGreaterThanOrEqual(2);

    expect(await rowsMentioning(old)).toEqual([]);
    expect(await rowsMentioning(oldSupport)).toEqual([]);
    expect(await rowsMentioning(young)).toEqual(["jobs"]);
    const jobs = await admin.query<{ id: string; payload: object; status: string }>(
      "SELECT id::text, payload, status FROM platform.jobs WHERE id = ANY($1::uuid[])",
      [[oldJob.jobId, oldSupportJob.jobId, youngJob.jobId]],
    );
    const byId = new Map(jobs.rows.map((row) => [row.id, row]));
    expect(byId.get(oldJob.jobId)).toMatchObject({ payload: {}, status: "canceled" });
    expect(byId.get(oldSupportJob.jobId)).toMatchObject({ payload: {}, status: "succeeded" });
    expect(byId.get(youngJob.jobId)).toMatchObject({ status: "pending" });
    // Already emptied jobs aren't counted again.
    const again = await admin.query(
      "SELECT count(*)::int AS n FROM platform.jobs WHERE id = ANY($1::uuid[]) AND payload <> '{}'::jsonb",
      [[oldJob.jobId, oldSupportJob.jobId]],
    );
    expect(again.rows[0]?.n).toBe(0);
    const audit = await admin.query(
      `SELECT redacted_payload FROM platform.product_audit_events
       WHERE action='platform.contact_submission.retention_purged' ORDER BY recorded_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.redacted_payload).toMatchObject({ olderThan: "90 days" });
  });
});
