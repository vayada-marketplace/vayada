import pg, { type QueryResultRow } from "pg";

import {
  CONTACT_NOTIFICATION_JOB_TYPE,
  CONTACT_NOTIFICATION_QUEUE,
} from "../routes/platformContactIntake.js";
import type { BookingEmailDelivery } from "./bookingEmailDelivery.js";

// VAY-2286: each vayada.com contact-form message is emailed to one team address (config
// CONTACT_NOTIFICATION_RECIPIENT) through the booking email provider, with Reply-To set to the
// visitor. In-app support jobs share the job type but are not sent. The audit and failure records
// written here hold no personal data: that stays in the job row until retention empties it.

type ContactJob = {
  id: string;
  jobKey: string;
  attemptsCount: number;
  workerId: string;
  createdAt: Date | string;
  payload: Record<string, unknown>;
};

type ContactNotificationPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

const USER_TYPES: Record<string, string> = { hotel: "Hotel owner or manager", other: "Other" };
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** "Vayada Bookings <bookings@vayada.com>" → "vayada.com contact form <bookings@vayada.com>". */
export function contactNotificationSender(from: string): string {
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  return `vayada.com contact form <${address}>`;
}

export function contactNotificationEmail(
  payload: Record<string, unknown>,
  receivedAt: Date | string,
): { subject: string; text: string; replyTo?: string } {
  const field = (key: string) => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");
  const name = field("name");
  const email = field("email");
  const message = field("message");
  if (!name || !email || !message) throw new Error("Contact message is incomplete.");
  const userType = field("userType");
  const text = [
    "New message from the contact form on vayada.com.",
    "",
    `Name: ${oneLine(name)}`,
    `Email: ${oneLine(email)}`,
    `Phone: ${oneLine(field("phone") ?? "-")}`,
    `Company: ${oneLine(field("company") ?? "-")}`,
    `Country: ${oneLine(field("country") ?? "-")}`,
    `I am a: ${userType ? (USER_TYPES[userType] ?? oneLine(userType)) : "-"}`,
    `Received: ${new Date(receivedAt).toISOString()}`,
    "",
    "Message:",
    message,
    "",
    EMAIL.test(email)
      ? `Reply to this email to answer ${oneLine(name)} directly.`
      : "The email address looks invalid, so replies go to the sender address.",
  ].join("\n");
  return {
    subject: `Contact form: ${oneLine(name).slice(0, 120)}`,
    text,
    ...(EMAIL.test(email) ? { replyTo: email } : {}),
  };
}

export async function runContactNotificationJobs(
  connectionString: string,
  delivery: BookingEmailDelivery,
  options: { recipient: string; workerId?: string; limit?: number; pool?: ContactNotificationPool },
): Promise<{ processed: number; failed: number }> {
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 1 });
  let processed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < (options.limit ?? 10); index += 1) {
      const job = await claimContactJob(pool, options.workerId ?? `contact-email:${process.pid}`);
      if (!job) break;
      const startedAt = Date.now();
      try {
        const email = contactNotificationEmail(job.payload, job.createdAt);
        await delivery.send({ to: options.recipient, idempotencyKey: job.jobKey, ...email });
        if (await finishContactJob(pool, job, startedAt, "succeeded")) processed += 1;
      } catch {
        if (await finishContactJob(pool, job, startedAt, "failed")) failed += 1;
      }
    }
    return { processed, failed };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

async function claimContactJob(
  pool: ContactNotificationPool,
  workerId: string,
): Promise<ContactJob | null> {
  const result = await pool.query<ContactJob>(
    `UPDATE platform.jobs job
     SET status = 'running',
         attempts_count = attempts_count + 1,
         locked_at = now(),
         locked_by = $3,
         updated_at = now()
     FROM (
       SELECT id
       FROM platform.jobs
       WHERE queue_name = $1
         AND job_type = $2
         AND job_metadata ->> 'channel' = 'contact_form'
         AND payload <> '{}'::jsonb
         AND (
           status = 'pending'
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
         )
         AND run_after <= now()
         AND attempts_count < max_attempts
       ORDER BY priority DESC, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text AS id,
       job.job_key AS "jobKey",
       job.attempts_count AS "attemptsCount",
       job.locked_by AS "workerId",
       job.created_at AS "createdAt",
       job.payload`,
    [CONTACT_NOTIFICATION_QUEUE, CONTACT_NOTIFICATION_JOB_TYPE, workerId],
  );
  const job = result.rows[0] ?? null;
  if (job) {
    await pool.query(
      `UPDATE platform.job_attempts
       SET status = 'timed_out', finished_at = now(),
           duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
           error_type = 'worker_timeout', error_message = 'Worker lease expired.'
       WHERE job_id = $1::uuid AND attempt_number < $2 AND status = 'running'`,
      [job.id, job.attemptsCount],
    );
    await pool.query(
      `INSERT INTO platform.job_attempts (job_id, attempt_number, status, worker_id, started_at)
       VALUES ($1::uuid, $2, 'running', $3, now())
       ON CONFLICT (job_id, attempt_number) DO NOTHING`,
      [job.id, job.attemptsCount, job.workerId],
    );
  }
  return job;
}

/** Records the outcome in one statement; a failure retries after 30 seconds up to max_attempts. */
async function finishContactJob(
  pool: ContactNotificationPool,
  job: ContactJob,
  startedAt: number,
  outcome: "succeeded" | "failed",
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `WITH attempt AS (
       UPDATE platform.job_attempts
       SET status = $6, finished_at = now(), duration_ms = $3,
           error_type = CASE WHEN $6 = 'failed' THEN 'delivery_error' END,
           error_message = CASE WHEN $6 = 'failed' THEN 'Contact notification delivery failed.' END,
           retry_after = CASE WHEN $6 = 'failed' THEN now() + interval '30 seconds' END
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running' AND worker_id = $5
       RETURNING id
     ), finished AS (
       UPDATE platform.jobs
       SET status = CASE
             WHEN $6 = 'succeeded' THEN 'succeeded'
             WHEN attempts_count >= max_attempts THEN 'dead_lettered'
             ELSE 'pending'
           END,
           run_after = CASE WHEN $6 = 'failed' THEN now() + interval '30 seconds' ELSE run_after END,
           finished_at = CASE
             WHEN $6 = 'succeeded' OR attempts_count >= max_attempts THEN now()
           END,
           locked_at = NULL, locked_by = NULL, updated_at = now(),
           job_metadata = CASE WHEN $6 = 'failed'
             THEN job_metadata || jsonb_build_object('lastError', 'Contact notification delivery failed.')
             ELSE job_metadata END
       WHERE id = $1::uuid AND status = 'running' AND locked_by = $5 AND attempts_count = $2
         AND EXISTS (SELECT 1 FROM attempt)
       RETURNING *
     ), dead_letter AS (
       INSERT INTO platform.dead_letter_events (
         source_kind, job_id, job_attempt_id, tenant_scope,
         resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, reason_code, failure_summary, failure_payload
       )
       SELECT 'job', job.id, attempt.id, job.tenant_scope,
         job.resource_product, job.resource_type, job.resource_id, job.correlation_id,
         job.idempotency_key_hash, 'contact_notification_delivery_exhausted',
         'Contact notification delivery failed.',
         jsonb_build_object('attemptNumber', $2::integer, 'jobType', job.job_type)
       FROM finished job CROSS JOIN attempt
       WHERE job.status = 'dead_lettered'
       RETURNING id
     )
     INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at, tenant_scope, actor_type,
       target_resource_product, target_resource_type, target_resource_id,
       job_id, correlation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     )
     SELECT $4, 'platform', 'platform.contact_notification.delivery_' || $6, 1, now(),
       job.tenant_scope, 'system', job.resource_product, job.resource_type, job.resource_id,
       job.id, job.correlation_id,
       jsonb_build_object('outcome', $6::text, 'attemptNumber', $2::integer),
       '{}'::jsonb,
       jsonb_build_object(
         'jobType', job.job_type,
         'queueName', job.queue_name,
         'deadLettered', job.status = 'dead_lettered'
       ),
       'standard', 'internal'
     FROM finished job
     ON CONFLICT (product, audit_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      job.id,
      job.attemptsCount,
      Date.now() - startedAt,
      `contact-notification:${job.id}:${job.attemptsCount}:${outcome}`,
      job.workerId,
      outcome,
    ],
  );
  return result.rows.length > 0;
}
