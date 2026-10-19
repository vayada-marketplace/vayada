import pg, { type QueryResultRow } from "pg";

import {
  CONTACT_NOTIFICATION_JOB_TYPE,
  CONTACT_NOTIFICATION_QUEUE,
} from "../routes/platformContactIntake.js";
import type { BookingEmailDelivery } from "./bookingEmailDelivery.js";

// VAY-2286: each vayada.com contact-form message and each in-app support request is emailed to one
// team address (config CONTACT_NOTIFICATION_RECIPIENT) through the booking email provider, with
// Reply-To set to the sender. Jobs queued before the channel existed (no job_metadata.channel) are
// not sent. The audit and failure records written here hold no personal data: that stays in the
// job row until retention empties it.

type ContactJob = {
  id: string;
  jobKey: string;
  attemptsCount: number;
  workerId: string;
  createdAt: Date | string;
  channel: "contact_form" | "in_app_support";
  payload: Record<string, unknown>;
};

type ContactNotificationPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

/** Contact emails sent per hour at most, so a flood can't use up the provider's limits that
 * booking emails share; the rest wait in the queue. */
export const CONTACT_NOTIFICATION_HOURLY_CAP = 30;
const USER_TYPES: Record<string, string> = { hotel: "Hotel owner or manager", other: "Other" };
const SUPPORT_KINDS: Record<string, string> = { support: "Support request", bug: "Bug report" };
const SUPPORT_APPS: Record<string, string> = { booking: "Booking Admin", pms: "PMS" };
/** A label for a known value; free text (the public form's "I am a") never reaches inherited keys. */
const labelOf = (labels: Record<string, string>, value: unknown) =>
  typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : undefined;
// Reply-To only for a plain ASCII address the provider accepts; others still appear in the text.
const REPLY_TO = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PROVIDER_ERROR = /^Booking email provider returned HTTP \d{3}\.$/;

/** A stored message the worker can never send (emptied or malformed): dead-lettered at once. */
export class IncompleteNotificationError extends Error {}

/** "Vayada Bookings <bookings@vayada.com>" → "Vayada contact and support <bookings@vayada.com>". */
export function contactNotificationSender(from: string): string {
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  return `Vayada contact and support <${address}>`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Subject text cut at a character boundary (never inside an emoji). */
const clip = (value: string, length: number) => Array.from(value).slice(0, length).join("");

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
  if (!name || !email || !message)
    throw new IncompleteNotificationError("Contact message is incomplete.");
  const userType = field("userType");
  const text = [
    "New message from the contact form on vayada.com.",
    "",
    `Name: ${oneLine(name)}`,
    `Email: ${oneLine(email)}`,
    `Phone: ${oneLine(field("phone") ?? "-")}`,
    `Company: ${oneLine(field("company") ?? "-")}`,
    `Country: ${oneLine(field("country") ?? "-")}`,
    `I am a: ${userType ? (labelOf(USER_TYPES, userType) ?? oneLine(userType)) : "-"}`,
    `Received: ${new Date(receivedAt).toISOString()}`,
    "",
    "Message:",
    message,
    "",
    REPLY_TO.test(email)
      ? `Reply to this email to answer ${oneLine(name)} directly.`
      : "Reply-To is not set for this address: write to it directly.",
  ].join("\n");
  return {
    subject: `Contact form: ${clip(oneLine(name), 120)}`,
    text,
    ...(REPLY_TO.test(email) ? { replyTo: email } : {}),
  };
}

/** In-app support request (stored by POST /api/support): kind, app, hotel account, page, message. */
export function supportNotificationEmail(
  payload: Record<string, unknown>,
  receivedAt: Date | string,
  hotelNames: readonly string[] = [],
): { subject: string; text: string; replyTo?: string } {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(payload["message"]));
  } catch {
    parsed = null;
  }
  const request = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const email = text(payload["email"]);
  const message = text(request["message"]);
  if (!email || !message) throw new IncompleteNotificationError("Support request is incomplete.");
  const name = oneLine(text(payload["name"]) ?? email);
  const kind = labelOf(SUPPORT_KINDS, request["kind"]) ?? "Support request";
  const app =
    labelOf(SUPPORT_APPS, request["product"]) ?? oneLine(text(request["product"]) ?? "app");
  // The account's hotels by name (self-signup account names are generated from the email); the
  // account name only when no hotel is linked yet.
  const account = text(request["organizationName"]);
  const hotels = hotelNames.map(oneLine);
  const hotel =
    hotels.length > 0
      ? `${hotels.slice(0, 3).join(", ")}${hotels.length > 3 ? ` +${hotels.length - 3}` : ""}`
      : oneLine(account ?? "unnamed hotel account");
  return {
    subject: clip(`${kind} · ${app} · ${hotel}`, 160),
    text: [
      `New ${kind.toLowerCase()} from ${app}.`,
      "",
      `Hotel: ${hotels.length > 0 ? hotels.join(", ") : "-"}`,
      `Account: ${oneLine(account ?? "-")}`,
      `Name: ${name}`,
      `Email: ${oneLine(email)}`,
      `Page: ${oneLine(text(request["page"]) ?? "-")}`,
      `Received: ${new Date(receivedAt).toISOString()}`,
      `User ID: ${oneLine(text(request["userId"]) ?? "-")}`,
      `Organization ID: ${oneLine(text(request["organizationId"]) ?? "-")}`,
      "",
      "Message:",
      message,
      "",
      REPLY_TO.test(email)
        ? `Reply to this email to answer ${name} directly.`
        : "Reply-To is not set for this address: write to it directly.",
    ].join("\n"),
    ...(REPLY_TO.test(email) ? { replyTo: email } : {}),
  };
}

export async function runContactNotificationJobs(
  connectionString: string,
  delivery: BookingEmailDelivery,
  options: {
    recipient: string;
    workerId?: string;
    limit?: number;
    hourlyCap?: number;
    pool?: ContactNotificationPool;
  },
): Promise<{ processed: number; failed: number; deadLettered: number; lastError?: string }> {
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 1 });
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;
  let lastError: string | undefined;
  try {
    const sentLastHour = await pool.query<{ sent: number }>(
      `SELECT count(*)::integer AS sent FROM platform.jobs
       WHERE queue_name = $1 AND job_type = $2
         AND job_metadata ->> 'channel' IN ('contact_form', 'in_app_support')
         AND status = 'succeeded' AND finished_at > now() - interval '1 hour'`,
      [CONTACT_NOTIFICATION_QUEUE, CONTACT_NOTIFICATION_JOB_TYPE],
    );
    const allowed = Math.min(
      options.limit ?? 10,
      (options.hourlyCap ?? CONTACT_NOTIFICATION_HOURLY_CAP) - (sentLastHour.rows[0]?.sent ?? 0),
    );
    for (let index = 0; index < allowed; index += 1) {
      const job = await claimContactJob(pool, options.workerId ?? `contact-email:${process.pid}`);
      if (!job) break;
      const startedAt = Date.now();
      try {
        const email =
          job.channel === "in_app_support"
            ? supportNotificationEmail(job.payload, job.createdAt, await hotelNamesFor(pool, job))
            : contactNotificationEmail(job.payload, job.createdAt);
        // VAY-2293: tagged so the Resend webhook acknowledges its events instead of matching them
        // against PMS Inbox messages.
        await delivery.send({
          to: options.recipient,
          idempotencyKey: job.jobKey,
          emailProduct: "platform",
          ...email,
        });
        if ((await finishContactJob(pool, job, startedAt, "succeeded")).recorded) processed += 1;
      } catch (error) {
        // Only the provider's status line is kept; never the message or the visitor's details.
        const message = error instanceof Error ? error.message : "";
        lastError = PROVIDER_ERROR.test(message)
          ? message
          : "Contact notification delivery failed.";
        const result = await finishContactJob(
          pool,
          job,
          startedAt,
          "failed",
          error instanceof IncompleteNotificationError,
        );
        if (result.recorded) failed += 1;
        if (result.deadLettered) deadLettered += 1;
      }
    }
    return { processed, failed, deadLettered, ...(lastError ? { lastError } : {}) };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

/** Names of the hotels the support request's organization owns or operates (at most 4). */
async function hotelNamesFor(pool: ContactNotificationPool, job: ContactJob): Promise<string[]> {
  let organizationId: unknown;
  try {
    organizationId = (JSON.parse(String(job.payload["message"])) as Record<string, unknown>)
      ?.organizationId;
  } catch {
    return [];
  }
  if (typeof organizationId !== "string" || !UUID.test(organizationId)) return [];
  const result = await pool.query<{ name: string }>(
    `SELECT property.display_name AS name
     FROM identity.organization_resource_links link
     JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
     WHERE link.organization_id = $1::uuid
       AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
       AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
     ORDER BY property.display_name
     LIMIT 4`,
    [organizationId],
  );
  return result.rows.map((row) => row.name);
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
         AND job_metadata ->> 'channel' IN ('contact_form', 'in_app_support')
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
       job.job_metadata ->> 'channel' AS channel,
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

/** Records the outcome in one statement. A failure retries after 1 min, 5 min, 30 min, then 2 h,
 * up to max_attempts (5 by default, about 2.5 hours), then dead-letters. */
async function finishContactJob(
  pool: ContactNotificationPool,
  job: ContactJob,
  startedAt: number,
  outcome: "succeeded" | "failed",
  permanent = false,
): Promise<{ recorded: boolean; deadLettered: boolean }> {
  const result = await pool.query<{ id: string; deadLettered: boolean }>(
    `WITH retry AS (
       SELECT CASE $2::integer
         WHEN 1 THEN interval '1 minute'
         WHEN 2 THEN interval '5 minutes'
         WHEN 3 THEN interval '30 minutes'
         ELSE interval '2 hours'
       END AS backoff
     ), attempt AS (
       UPDATE platform.job_attempts
       SET status = $6, finished_at = now(), duration_ms = $3,
           error_type = CASE WHEN $6 = 'failed' THEN 'delivery_error' END,
           error_message = CASE WHEN $6 = 'failed' THEN 'Contact notification delivery failed.' END,
           retry_after = CASE WHEN $6 = 'failed' THEN now() + (SELECT backoff FROM retry) END
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running' AND worker_id = $5
       RETURNING id
     ), finished AS (
       UPDATE platform.jobs
       SET status = CASE
             WHEN $6 = 'succeeded' THEN 'succeeded'
             WHEN attempts_count >= max_attempts OR $7::boolean THEN 'dead_lettered'
             ELSE 'pending'
           END,
           run_after = CASE WHEN $6 = 'failed' THEN now() + (SELECT backoff FROM retry) ELSE run_after END,
           finished_at = CASE
             WHEN $6 = 'succeeded' OR attempts_count >= max_attempts OR $7::boolean THEN now()
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
     RETURNING id::text AS id, (audit_metadata ->> 'deadLettered')::boolean AS "deadLettered"`,
    [
      job.id,
      job.attemptsCount,
      Date.now() - startedAt,
      `contact-notification:${job.id}:${job.attemptsCount}:${outcome}`,
      job.workerId,
      outcome,
      permanent,
    ],
  );
  const row = result.rows[0];
  return { recorded: Boolean(row), deadLettered: row?.deadLettered === true };
}
