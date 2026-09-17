import type pg from "pg";

export type ChannexAlertDiagnostics = {
  alertId: string;
  recoveryRound: number;
  observedAt: string;
  newerOccurrence: boolean;
  linkedJobCount: number;
  latestReceipt: { receiptId: string; occurredAt: string; receivedAt: string } | null;
  recovery: {
    jobId: string;
    operation: "booking_import" | "sync_bookings" | "sync_ari";
    status: string;
    updatedAt: string;
    attemptsMade: number;
    failure: string | null;
  }[];
};

// Fixed explanations only: never expose provider messages, payloads or arbitrary error codes.
const failures: Record<string, string> = {
  mapping_missing: "A required room or rate mapping is missing.",
  provider_unavailable: "The provider could not complete or confirm the request.",
  provider_rejected: "The provider rejected the request.",
  invalid_state: "The connection or configuration is not ready for this action.",
  PRICING_UNAVAILABLE: "Rate synchronization is not available yet.",
  rate_limited: "The provider limited requests. Check the retry status.",
};

export async function getChannexAlertDiagnostics(
  client: Pick<pg.Pool, "query">,
  propertyId: string,
  alertId: string,
): Promise<ChannexAlertDiagnostics | null> {
  // One SELECT snapshot. Unlike the existing alert list, this never reconciles resolution.
  const result = await client.query<
    Omit<ChannexAlertDiagnostics, "recovery"> & {
      recovery: (ChannexAlertDiagnostics["recovery"][number] & { failureCode?: string })[];
    }
  >(
    `SELECT a.id::text AS "alertId", a.recovery_round AS "recoveryRound", now() AS "observedAt",
      COALESCE(a.last_occurred_at > a.recovery_started_at, false) AS "newerOccurrence",
      cardinality(a.recovery_jobs) AS "linkedJobCount",
      (SELECT jsonb_build_object('receiptId', o.receipt_id, 'occurredAt', o.occurred_at,
        'receivedAt', o.last_delivered_at) FROM pms.channel_operational_alert_occurrences o
        WHERE o.alert_id=a.id ORDER BY o.occurred_at DESC,o.receipt_id LIMIT 1) AS "latestReceipt",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'jobId', j.id, 'operation', CASE WHEN j.job_type='channex.ingest-booking'
          THEN 'booking_import' ELSE j.payload->>'operationType' END,
        'status', j.status, 'updatedAt', j.updated_at, 'attemptsMade', j.attempts_count,
        'failureCode', CASE WHEN j.status IN ('pending','failed','dead_lettered')
          THEN j.job_metadata->>'lastErrorCode' END) ORDER BY j.created_at,j.id)
        FROM platform.jobs j WHERE j.id=ANY(a.recovery_jobs) AND (
          (j.queue_name='pms.channex.webhooks' AND j.job_type='channex.ingest-booking'
            AND j.payload->>'propertyId'=a.property_id::text
            AND j.payload->>'providerPropertyId'=c.external_property_id
            AND j.payload->>'recoveryAlertId'=a.id::text
            AND (NOT (j.payload ? 'bindingGeneration') OR j.payload->>'bindingGeneration'=a.binding_generation::text)
            AND j.job_key='alert:'||a.id::text||':round:'||(a.recovery_round-1)::text)
          OR (j.queue_name='pms.channex.management' AND j.property_id=a.property_id
            AND j.payload->>'recoveryAlertId'=a.id::text
            AND j.payload->>'commandId'='alert:'||a.id::text||':round:'||(a.recovery_round-1)::text
            AND j.payload->>'operationType' IN ('sync_bookings','sync_ari')
            AND j.job_type='channex.'||(j.payload->>'operationType'))
        )), '[]'::jsonb) AS recovery
      FROM pms.channel_operational_alerts a JOIN pms.channel_connections c
        ON c.id=a.connection_id AND c.property_id=a.property_id
          AND c.binding_generation=a.binding_generation AND c.provider='channex'
      WHERE a.property_id=$1::uuid AND a.id=$2::uuid`,
    [propertyId, alertId],
  );
  const row = result.rows[0];
  return row
    ? {
        ...row,
        recovery: row.recovery.map(({ failureCode, ...job }) => ({
          ...job,
          failure: failureCode
            ? Object.hasOwn(failures, failureCode)
              ? failures[failureCode]!
              : "Failure details are unavailable. Contact support with the alert reference."
            : null,
        })),
      }
    : null;
}
