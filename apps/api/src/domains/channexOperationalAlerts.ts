import { createHash } from "node:crypto";
import type pg from "pg";
import type { ProviderWebhookReceiptInput } from "../routes/providerWebhooks.js";

export const CHANNEX_ALERT_EVENTS = new Set([
  "booking_unmapped_room",
  "booking_unmapped_rate",
  "non_acked_booking",
  "sync_error",
  "sync_warning",
  "rate_error",
  "disconnected_channel",
]);

export function alertImpact(raw: Record<string, unknown>) {
  const p = record(raw.payload);
  const safe = (value: unknown) =>
    typeof value === "string" && /^[\p{L}\p{N} ._:/-]{1,100}$/u.test(value) ? value : null;
  const date = (value: unknown) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
      ? value
      : null;
  return {
    bookingId: safe(p.booking_id),
    revisionId: safe(p.booking_revision_id),
    channelId: safe(p.channel_id),
    channel: safe(p.channel_name ?? p.channel ?? p.ota_name),
    roomTypeId: safe(p.room_type_id),
    ratePlanId: safe(p.rate_plan_id),
    dateFrom: date(p.date_from ?? p.arrival_date),
    dateTo: date(p.date_to ?? p.departure_date),
    errorType: safe(p.error_type),
  };
}

export async function recordChannexAlert(
  client: Pick<pg.PoolClient, "query">,
  input: ProviderWebhookReceiptInput,
  receiptId: string,
) {
  if (input.provider !== "channex" || !CHANNEX_ALERT_EVENTS.has(input.eventType)) return;
  const preview = input.normalizedPreview.payload;
  if (preview.propertyOwnerResolved !== true) return;
  const prior = await client.query(
    "UPDATE pms.channel_operational_alert_occurrences SET deliveries=deliveries+1,last_delivered_at=now() WHERE receipt_id=$1::uuid RETURNING alert_id",
    [receiptId],
  );
  if (prior.rows.length) return;
  const binding = (
    await client.query<{ id: string; generation: string }>(
      `SELECT id::text,binding_generation::text AS generation FROM pms.channel_connections
     WHERE property_id=$1::uuid AND provider='channex' AND external_property_id=$2
     AND connection_status IN ('connected','degraded') FOR SHARE`,
      [preview.propertyId, preview.providerPropertyId],
    )
  ).rows[0];
  if (!binding) return;
  const impact = alertImpact(input.rawPayload);
  const problemKey = createHash("sha256")
    .update(JSON.stringify([input.eventType, impact]))
    .digest("hex");
  const timestamp = input.rawPayload.timestamp;
  const occurredAt =
    typeof timestamp === "string" &&
    Number.isFinite(Date.parse(timestamp)) &&
    Date.parse(timestamp) <= Date.now()
      ? new Date(timestamp)
      : new Date();
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `channex-alert:${binding.id}:${problemKey}`,
  ]);
  // Late delivery belongs to its already verified incident, not a new recurrence.
  const resolved = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM pms.channel_operational_alerts WHERE connection_id=$1::uuid AND binding_generation=$2::uuid AND problem_key=$3 AND resolved_at >= $4::timestamptz ORDER BY resolved_at LIMIT 1`,
      [binding.id, binding.generation, problemKey, occurredAt],
    )
  ).rows[0];
  const alert =
    resolved ??
    (
      await client.query<{ id: string }>(
        `INSERT INTO pms.channel_operational_alerts(property_id,connection_id,binding_generation,problem_key,event_type,impact,first_occurred_at,last_occurred_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$7)
     ON CONFLICT(connection_id,binding_generation,problem_key) WHERE resolved_at IS NULL DO UPDATE
     SET first_occurred_at=LEAST(pms.channel_operational_alerts.first_occurred_at,EXCLUDED.first_occurred_at),
         last_occurred_at=GREATEST(pms.channel_operational_alerts.last_occurred_at,EXCLUDED.last_occurred_at)
     RETURNING id::text`,
        [
          preview.propertyId,
          binding.id,
          binding.generation,
          problemKey,
          input.eventType,
          JSON.stringify(impact),
          occurredAt,
        ],
      )
    ).rows[0]!;
  await client.query(
    "INSERT INTO pms.channel_operational_alert_occurrences(receipt_id,alert_id,occurred_at) VALUES($1::uuid,$2::uuid,$3)",
    [receiptId, alert.id, occurredAt],
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type ChannexAlert = {
  id: string;
  eventType: string;
  impact: ReturnType<typeof alertImpact>;
  firstOccurredAt: string;
  lastOccurredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  recoveryRound: number;
  occurrences: number;
  recovery: {
    status: string;
    verified: boolean;
    attemptsMade: number;
    maxAttempts: number;
    retryAfter: string | null;
  }[];
};

export async function listChannexAlerts(
  client: Pick<pg.Pool, "query">,
  propertyId: string,
): Promise<ChannexAlert[]> {
  // Only successful canonical jobs carrying verified provider evidence can close an incident.
  await client.query(
    `UPDATE pms.channel_operational_alerts alert SET resolved_at=now()
    WHERE alert.property_id=$1::uuid AND alert.resolved_at IS NULL
      AND cardinality(alert.recovery_jobs)>0 AND alert.last_occurred_at<=alert.recovery_started_at
      AND EXISTS(SELECT 1 FROM pms.channel_connections connection WHERE connection.id=alert.connection_id AND connection.binding_generation=alert.binding_generation)
      AND NOT EXISTS(SELECT 1 FROM unnest(alert.recovery_jobs) AS linked(job_id) LEFT JOIN platform.jobs job ON job.id=linked.job_id
        WHERE job.id IS NULL OR job.status<>'succeeded' OR job.job_metadata->>'alertRecoveryVerified' IS DISTINCT FROM 'true')`,
    [propertyId],
  );
  const result = await client.query<ChannexAlert>(
    `SELECT alert.id::text, alert.event_type AS "eventType", alert.impact,
    alert.first_occurred_at AS "firstOccurredAt",alert.last_occurred_at AS "lastOccurredAt",
    alert.acknowledged_at AS "acknowledgedAt",alert.resolved_at AS "resolvedAt",alert.recovery_round AS "recoveryRound",
    (SELECT count(*)::int FROM pms.channel_operational_alert_occurrences WHERE alert_id=alert.id) AS occurrences,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('status',job.status,'verified',COALESCE(job.job_metadata->'alertRecoveryVerified','false'::jsonb),'attemptsMade',job.attempts_count,'maxAttempts',job.max_attempts,'retryAfter',CASE WHEN job.status='pending' THEN job.run_after END)) FROM platform.jobs job WHERE job.id=ANY(alert.recovery_jobs)), '[]'::jsonb) AS recovery
    FROM pms.channel_operational_alerts alert JOIN pms.channel_connections connection ON connection.id=alert.connection_id AND connection.binding_generation=alert.binding_generation
    WHERE alert.property_id=$1::uuid ORDER BY alert.resolved_at NULLS FIRST,alert.last_occurred_at DESC LIMIT 100`,
    [propertyId],
  );
  return result.rows;
}
