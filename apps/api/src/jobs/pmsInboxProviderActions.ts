import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PmsInboxProviderAction } from "../domains/pmsInbox.js";
import { lockPmsInboxReplyActorScope } from "../domains/pmsInboxProviderActionCommand.js";
import {
  nextPmsInboxDeliveryRunAt,
  projectPmsInboxDeliveryFailure,
  type PmsInboxDeliveryProviderResult,
} from "../domains/pmsInboxDelivery.js";

const JOB = "pms.inbox.provider-action.deliver";
type Payload = {
  propertyId: string;
  threadId: string;
  action: PmsInboxProviderAction;
  expectedVersion?: number;
  providerConversationId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
};
type Job = {
  id: string;
  payload: Payload;
  attempts_count: number;
  max_attempts: number;
  job_metadata: Record<string, unknown>;
};

// Durable dispatch marker prevents lease recovery from repeating an uncertain POST.
export async function runPmsInboxProviderActions(
  pool: pg.Pool,
  execute: ((input: Payload) => Promise<PmsInboxDeliveryProviderResult>) | undefined,
) {
  const worker = `pms-inbox-provider:${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<Job>(
      `
      UPDATE platform.jobs job SET status = 'running', locked_at = now(), locked_by = $2,
        attempts_count = attempts_count + 1, updated_at = now()
      FROM (SELECT id FROM platform.jobs WHERE job_type = $1
        AND ((status = 'pending' AND run_after <= now() AND attempts_count < max_attempts)
          OR (status = 'running' AND locked_at < now() - interval '2 minutes'))
        ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1) candidate
      WHERE job.id = candidate.id RETURNING job.*`,
      [JOB, worker],
    );
    const job = claimed.rows[0];
    if (!job) {
      await client.query("COMMIT");
      return;
    }
    const input = job.payload;
    await client.query(
      `UPDATE platform.job_attempts SET status = 'timed_out', finished_at = now(), error_type = 'worker_timeout'
      WHERE job_id = $1 AND status = 'running'`,
      [job.id],
    );
    await client.query(
      `INSERT INTO platform.job_attempts (job_id, attempt_number, status, worker_id, started_at)
      VALUES ($1, $2, 'running', $3, now())`,
      [job.id, job.attempts_count, worker],
    );
    const access =
      input.organizationId && input.actorUserId && input.actorMembershipId
        ? await lockPmsInboxReplyActorScope(client, input, new Date())
        : false;
    const thread = await client.query<{ version: string; eligible: boolean }>(
      `
      SELECT thread.version::text, (thread.source = 'channex' AND thread.delivery_channel = 'ota'
        AND thread.source_thread_id = $3 AND BTRIM(thread.source_thread_id) <> ''
        AND ($4 = 'channex_close' OR ($4 = 'booking_com_no_reply_needed'
          AND lower(BTRIM(thread.provider_channel)) IN ('booking.com', 'booking_com', 'bookingcom')))
        AND EXISTS (SELECT 1 FROM pms.channel_connections connection WHERE connection.property_id = thread.property_id
          AND connection.provider = 'channex' AND connection.connection_status IN ('connected', 'degraded') AND connection.messaging_app_installed)) AS eligible
      FROM pms.message_threads thread WHERE thread.property_id = $1 AND thread.id = $2 FOR UPDATE`,
      [input.propertyId, input.threadId, input.providerConversationId, input.action],
    );
    let result: PmsInboxDeliveryProviderResult | undefined;
    let reason: string | undefined;
    if (job.job_metadata.dispatched) result = { ok: false, failure: "ambiguous_provider_outcome" };
    else if (!execute || !thread.rows[0]?.eligible)
      result = { ok: false, failure: "provider_configuration_unavailable" };
    else if (!input.expectedVersion || Number(thread.rows[0].version) !== input.expectedVersion) {
      result = { ok: false, failure: "invalid_delivery_payload" };
      reason = "conversation_changed";
    } else if (!access) result = { ok: false, failure: "access_unavailable" };
    if (!result)
      await client.query(
        `UPDATE platform.jobs SET job_metadata = job_metadata || '{"dispatched":true}'::jsonb WHERE id = $1`,
        [job.id],
      );
    await client.query("COMMIT");
    result ??= await execute!(input).catch(
      () => ({ ok: false, failure: "ambiguous_provider_outcome" }) as const,
    );
    const projection = result.ok
      ? null
      : projectPmsInboxDeliveryFailure(result.failure, job.attempts_count, job.max_attempts);
    const outcome = result.ok ? "confirmed" : (projection!.state ?? "failed");
    reason ??= result.ok ? undefined : projection!.reasonCode;
    const retryAt = projection?.retry
      ? nextPmsInboxDeliveryRunAt(new Date(), job.attempts_count)
      : null;
    await client.query("BEGIN");
    const completed = await client.query(
      `UPDATE platform.jobs SET status = $3, locked_by = NULL, locked_at = NULL,
      finished_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END, run_after = COALESCE($4, run_after), updated_at = now(),
      job_metadata = job_metadata || jsonb_build_object('outcome', $5::text, 'reason', $6::text, 'dispatched', $7::boolean)
      WHERE id = $1 AND locked_by = $2 AND status = 'running' RETURNING source_outbox_event_id`,
      [
        job.id,
        worker,
        retryAt ? "pending" : result.ok ? "succeeded" : "failed",
        retryAt,
        outcome,
        reason ?? null,
        outcome === "held" && reason === "ambiguous_provider_outcome",
      ],
    );
    if (completed.rowCount) {
      await client.query(
        `UPDATE platform.job_attempts SET status = $4, finished_at = now(), error_type = $5, retry_after = $6
        WHERE job_id = $1 AND attempt_number = $2 AND worker_id = $3`,
        [
          job.id,
          job.attempts_count,
          worker,
          result.ok ? "succeeded" : "failed",
          reason ?? null,
          retryAt,
        ],
      );
      await client.query(
        `INSERT INTO platform.product_audit_events
        (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
         target_resource_product, target_resource_type, target_resource_id, job_id, domain_event_id,
         correlation_id, redacted_payload, retention_class, privacy_scope)
        SELECT $2, 'pms', 'pms.inbox.provider.completed', now(), 'property', property_id, 'system',
          resource_product, resource_type, resource_id, id, source_domain_event_id, correlation_id,
          $3::jsonb, 'standard', 'internal' FROM platform.jobs WHERE id = $1
        ON CONFLICT (product, audit_key) DO NOTHING`,
        [
          job.id,
          `provider-action:${job.id}:attempt:${job.attempts_count}`,
          JSON.stringify({ action: input.action, outcome, reason: reason ?? null }),
        ],
      );
      // The outbox intent was already materialized as this job in the command transaction.
      await client.query(
        `UPDATE platform.outbox_events SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1`,
        [completed.rows[0].source_outbox_event_id],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
