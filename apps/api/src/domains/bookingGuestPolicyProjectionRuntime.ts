import { randomUUID } from "node:crypto";

import {
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_OUTBOX_DESTINATION,
  BOOKING_GUEST_POLICY_RESOURCE_TYPE,
  type BookingGuestPolicyChangedEvent,
  type BookingGuestPolicyProjectionHandlerPort,
} from "@vayada/domain-booking";
import { type QueryResult, type QueryResultRow } from "pg";

type ProjectionClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingGuestPolicyProjectionPool = {
  connect(): Promise<ProjectionClient>;
};

type Claim = {
  outboxEventId: string;
  propertyId: string;
  organizationId: string | null;
  guestPolicyRevision: number | null;
  event: unknown;
  isCurrent: boolean;
  hasSource: boolean;
  attemptsCount: number;
  maxAttempts: number;
  leaseToken: string;
};

export type BookingGuestPolicyProjectionBatchResult = {
  processed: number;
  applied: number;
  conflicts: number;
  canceled: number;
  retrying: number;
  deadLettered: number;
};

const DESTINATION = BOOKING_GUEST_POLICY_OUTBOX_DESTINATION;
const EVENT_TYPE = BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE;
const RESOURCE_TYPE = BOOKING_GUEST_POLICY_RESOURCE_TYPE;

export function createBookingGuestPolicyOutboxProjector(config: {
  pool: BookingGuestPolicyProjectionPool;
  handler: BookingGuestPolicyProjectionHandlerPort;
  now?: () => Date;
  randomId?: () => string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}) {
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;
  const leaseDurationMs = positiveInteger(config.leaseDurationMs, 60_000);
  const retryDelayMs = positiveInteger(config.retryDelayMs, 30_000);
  return Object.freeze({
    async runBatch(input: { limit?: number; workerId?: string } = {}) {
      const result = emptyResult();
      const limit = positiveInteger(input.limit, 25);
      const workerId = input.workerId?.trim() || "booking-guest-policy-projection";
      for (let index = 0; index < limit; index += 1) {
        const processedAt = now();
        const claim = await claimNext(config.pool, {
          workerId,
          leaseToken: randomId(),
          claimedAt: processedAt,
          leaseDurationMs,
        });
        if (!claim) break;
        result.processed += 1;
        if (!claim.hasSource || !claim.organizationId || !claim.guestPolicyRevision) {
          await settle(config.pool, claim, {
            status: "failed",
            outcome: "source_binding_invalid",
            at: processedAt,
            exhausted: true,
          });
          result.deadLettered += 1;
          continue;
        }
        if (!claim.isCurrent) {
          await settle(config.pool, claim, {
            status: "canceled",
            outcome: "superseded_before_projection",
            at: processedAt,
          });
          result.canceled += 1;
          continue;
        }
        const handled = await config.handler
          .handleGuestPolicyProjection({
            organizationId: claim.organizationId,
            outboxEventId: claim.outboxEventId,
            event: claim.event as BookingGuestPolicyChangedEvent,
            processedAt: processedAt.toISOString(),
          })
          .catch(() => ({ outcome: "retry" as const, errorSource: "system" as const }));
        if (handled.outcome === "applied" || handled.outcome === "source_revision_conflict") {
          await settle(config.pool, claim, {
            status: "published",
            outcome: handled.outcome,
            at: processedAt,
          });
          result[handled.outcome === "applied" ? "applied" : "conflicts"] += 1;
          continue;
        }
        const exhausted = handled.outcome !== "retry" || claim.attemptsCount >= claim.maxAttempts;
        const outcome =
          handled.outcome === "retry"
            ? `${handled.errorSource}_unavailable`
            : "code" in handled
              ? handled.code
              : "catalog_projection_malformed";
        await settle(config.pool, claim, {
          status: "failed",
          outcome,
          at: processedAt,
          exhausted,
          retryAt: exhausted ? undefined : new Date(processedAt.getTime() + retryDelayMs),
        });
        result[exhausted ? "deadLettered" : "retrying"] += 1;
      }
      return result;
    },
  });
}

async function claimNext(
  pool: BookingGuestPolicyProjectionPool,
  input: { workerId: string; leaseToken: string; claimedAt: Date; leaseDurationMs: number },
): Promise<Claim | null> {
  const client = await pool.connect();
  const leasedUntil = new Date(input.claimedAt.getTime() + input.leaseDurationMs);
  try {
    await client.query("BEGIN");
    const claimed = await client.query<Omit<Claim, "leaseToken">>(
      `WITH candidate AS (
         SELECT outbox.id, outbox.property_id, outbox.payload, outbox.status,
                outbox.attempts_count, outbox.max_attempts,
                revision.organization_id, revision.guest_policy_revision,
                revision.revision_id IS NOT NULL AS has_source,
                current.revision_id IS NOT NULL AS is_current
           FROM platform.outbox_events outbox
      LEFT JOIN booking.guest_policy_revisions revision
             ON revision.outbox_event_id = outbox.id
            AND revision.property_id = outbox.property_id
            AND revision.revision_id::text = outbox.resource_id
      LEFT JOIN booking.current_working_guest_policy_revisions current
             ON current.property_id = revision.property_id
            AND current.organization_id = revision.organization_id
            AND current.revision_id = revision.revision_id
            AND current.guest_policy_revision = revision.guest_policy_revision
          WHERE outbox.destination = $1 AND outbox.event_type = $2
            AND outbox.resource_product = 'booking' AND outbox.resource_type = $3
            AND outbox.tenant_scope = 'property'
            AND (
              (outbox.status IN ('pending', 'failed')
                AND outbox.available_at <= $4::timestamptz
                AND outbox.attempts_count < outbox.max_attempts)
              OR (outbox.status = 'leased' AND outbox.leased_until <= $4::timestamptz)
            )
          ORDER BY outbox.priority DESC, outbox.available_at, outbox.created_at, outbox.id
          FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
       )
       UPDATE platform.outbox_events outbox
          SET status = 'leased',
              attempts_count = LEAST(outbox.attempts_count + 1, outbox.max_attempts),
              leased_until = $5::timestamptz, updated_at = $4::timestamptz,
              outbox_metadata = jsonb_set(outbox.outbox_metadata,
                '{bookingGuestPolicyProjection}',
                jsonb_build_object('workerId', $6::text, 'leaseToken', $7::text,
                  'claimedAt', $4::text, 'leaseExpiresAt', $5::text), true)
         FROM candidate WHERE outbox.id = candidate.id
        RETURNING outbox.id::text AS "outboxEventId",
                  outbox.property_id::text AS "propertyId",
                  candidate.organization_id::text AS "organizationId",
                  candidate.guest_policy_revision AS "guestPolicyRevision",
                  candidate.payload AS event, candidate.is_current AS "isCurrent",
                  candidate.has_source AS "hasSource",
                  outbox.attempts_count AS "attemptsCount",
                  outbox.max_attempts AS "maxAttempts"`,
      [
        DESTINATION,
        EVENT_TYPE,
        RESOURCE_TYPE,
        input.claimedAt.toISOString(),
        leasedUntil.toISOString(),
        input.workerId,
        input.leaseToken,
      ],
    );
    await client.query("COMMIT");
    return claimed.rows[0] ? { ...claimed.rows[0], leaseToken: input.leaseToken } : null;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function settle(
  pool: BookingGuestPolicyProjectionPool,
  claim: Claim,
  completion: {
    status: "published" | "failed" | "canceled";
    outcome: string;
    at: Date;
    retryAt?: Date;
    exhausted?: boolean;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE platform.outbox_events
          SET status = $4,
              attempts_count = CASE WHEN $5::boolean THEN max_attempts ELSE attempts_count END,
              available_at = COALESCE($6::timestamptz, available_at),
              leased_until = NULL,
              published_at = CASE WHEN $4 = 'published' THEN $7::timestamptz ELSE NULL END,
              updated_at = $7::timestamptz,
              outbox_metadata = jsonb_set(outbox_metadata,
                '{bookingGuestPolicyProjection}',
                jsonb_build_object('completedAt', $7::text, 'outcome', $8::text,
                  'exhausted', $5::boolean, 'nextRetryAt', $6::text), true)
        WHERE id = $1::uuid AND property_id = $2::uuid AND status = 'leased'
          AND outbox_metadata #>> '{bookingGuestPolicyProjection,leaseToken}' = $3`,
      [
        claim.outboxEventId,
        claim.propertyId,
        claim.leaseToken,
        completion.status,
        completion.exhausted ?? false,
        completion.retryAt?.toISOString() ?? null,
        completion.at.toISOString(),
        completion.outcome,
      ],
    );
    if (updated.rowCount !== 1)
      throw new Error("Booking guest-policy projection outbox lease was lost");
    if (completion.exhausted) await insertDeadLetter(client, claim, completion.outcome);
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function insertDeadLetter(
  client: ProjectionClient,
  claim: Claim,
  reasonCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.dead_letter_events (
       source_kind, outbox_event_id, tenant_scope, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, reason_code,
       failure_summary, failure_payload
     )
     SELECT 'outbox_event', outbox.id, outbox.tenant_scope, outbox.property_id,
            outbox.resource_product, outbox.resource_type, outbox.resource_id,
            outbox.correlation_id, outbox.idempotency_key_hash, $2,
            'Booking guest-policy projection could not be completed',
            jsonb_build_object('destination', outbox.destination,
              'eventType', outbox.event_type, 'attemptCount', outbox.attempts_count,
              'maxAttempts', outbox.max_attempts, 'replayEligible', true)
       FROM platform.outbox_events outbox
      WHERE outbox.id = $1::uuid
        AND NOT EXISTS (
          SELECT 1 FROM platform.dead_letter_events existing
           WHERE existing.source_kind = 'outbox_event'
             AND existing.outbox_event_id = outbox.id
             AND existing.reason_code = $2
             AND existing.recovery_status IN ('open', 'acknowledged')
        )`,
    [claim.outboxEventId, reasonCode],
  );
}

function emptyResult(): BookingGuestPolicyProjectionBatchResult {
  return { processed: 0, applied: 0, conflicts: 0, canceled: 0, retrying: 0, deadLettered: 0 };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

async function rollback(client: Pick<ProjectionClient, "query">): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}
