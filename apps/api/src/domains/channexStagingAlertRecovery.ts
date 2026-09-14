import pg from "pg";
import type { ApiConfig } from "../config.js";
import { runChannexBookingJobs } from "../jobs/channexBookings.js";

export type StagingAlertApproval = {
  alertId: string;
  round: number;
  canonicalBookingId: string;
  expiresAt: string;
  approvalRef: string;
};
type Scope = {
  propertyId: string;
  providerPropertyId: string;
  channelBookingId: string;
  revision: string;
  bindingGeneration: string;
};
export function stagingAlertProperty(config: ApiConfig): string | undefined {
  const c = config.channexManagement;
  return config.apiRuntime === "next" &&
    !config.backgroundWorkersEnabled &&
    c.apiBaseUrl === "https://staging.channex.io" &&
    c.apiKey &&
    c.capabilityModes.bookingSync === "observe_only"
    ? c.stagingRestrictionsPropertyId
    : undefined;
}

// Shared by preparation, admission and the worker, always within an owned transaction.
export async function assertStagingAlertApproval(
  client: {
    query<T extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }>;
  },
  scope: Scope,
  approval: StagingAlertApproval,
  jobId?: string,
) {
  const result = await client.query(
    `SELECT 1 FROM pms.channel_operational_alerts a
     JOIN pms.channel_connections c ON c.id=a.connection_id AND c.binding_generation=a.binding_generation
     JOIN pms.channel_binding_claims claim ON claim.property_id=c.property_id AND claim.provider=c.provider
       AND claim.external_property_id=c.external_property_id AND claim.claim_state='active'
     WHERE a.id=$1::uuid AND a.property_id=$2::uuid AND c.provider='channex'
       AND c.external_property_id=$3 AND c.binding_generation=$4::uuid AND c.connection_status='connected'
       AND a.event_type='non_acked_booking' AND a.resolved_at IS NULL
       AND a.impact->>'bookingId'=$5 AND a.impact->>'revisionId'=$6
       AND $7::timestamptz>now()
       AND (($8::uuid IS NULL AND a.recovery_round=$9 AND NOT EXISTS(
         SELECT 1 FROM platform.jobs WHERE id=ANY(a.recovery_jobs) AND status IN ('pending','running')))
         OR ($8::uuid=ANY(a.recovery_jobs) AND a.recovery_round=$9+1))
     FOR UPDATE OF a,c,claim`,
    [
      approval.alertId,
      scope.propertyId,
      scope.providerPropertyId,
      scope.bindingGeneration,
      scope.channelBookingId,
      scope.revision,
      approval.expiresAt,
      jobId ?? null,
      approval.round,
    ],
  );
  if (!result.rows.length) throw new Error("staging_alert_approval_invalid");
  const mappings = await client.query<{
    bookingId: string;
    revision: string;
    status: string;
    roomCount: number;
    position: number;
  }>(
    `SELECT m.guest_booking_id::text AS "bookingId",m.external_revision_id AS revision,m.sync_status AS status,b.room_count::int AS "roomCount",m.channel_room_index::int AS position
     FROM pms.channel_booking_mappings m JOIN pms.channel_connections c ON c.id=m.connection_id
     JOIN booking.guest_bookings b ON b.id=m.guest_booking_id AND b.property_id=m.property_id
     JOIN pms.operational_booking_assignments a ON a.id=m.assignment_id AND a.property_id=m.property_id
       AND a.guest_booking_id=m.guest_booking_id AND a.position=m.channel_room_index+1
       AND a.assignment_status NOT IN ('canceled','released')
     WHERE m.property_id=$1::uuid AND c.property_id=m.property_id AND c.provider='channex'
       AND c.external_property_id=$2 AND m.external_booking_id=$3
       AND b.lifecycle_status='confirmed' ORDER BY m.channel_room_index FOR UPDATE OF m,b,a`,
    [scope.propertyId, scope.providerPropertyId, scope.channelBookingId],
  );
  if (
    !mappings.rows.length ||
    mappings.rows.length !== mappings.rows[0]!.roomCount ||
    mappings.rows.some(
      (m, index) =>
        m.position !== index ||
        m.bookingId !== approval.canonicalBookingId ||
        m.revision !== scope.revision ||
        m.status !== "active",
    )
  )
    throw new Error("staging_alert_mapping_changed");
  return mappings.rows.length;
}

// Privileged operator entry point. Browser requests cannot prepare approvals or execute jobs.
export async function stagingAlertRecovery(
  config: ApiConfig,
  input: {
    alertId: string;
    providerPropertyId: string;
    channelBookingId: string;
    revision: string;
    canonicalBookingId: string;
    approvalRef: string;
    execute?: boolean;
  },
  request: typeof fetch = fetch,
) {
  const propertyId = stagingAlertProperty(config);
  const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (
    !propertyId ||
    !config.targetDatabaseUrl ||
    ![
      propertyId,
      input.alertId,
      input.providerPropertyId,
      input.channelBookingId,
      input.revision,
      input.canonicalBookingId,
    ].every((v) => uuid.test(v)) ||
    !/^VAY-\d+:[a-zA-Z0-9:_-]{1,120}$/.test(input.approvalRef)
  )
    throw new Error("invalid_staging_alert_scope");
  const pool = new pg.Pool({ connectionString: config.targetDatabaseUrl, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const alert = (
      await client.query<{ generation: string; round: number }>(
        `SELECT binding_generation::text generation,recovery_round round FROM pms.channel_operational_alerts
       WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
        [input.alertId, propertyId],
      )
    ).rows[0];
    if (!alert) throw new Error("staging_alert_missing");
    const scope: Scope = {
      propertyId,
      providerPropertyId: input.providerPropertyId,
      channelBookingId: input.channelBookingId,
      revision: input.revision,
      bindingGeneration: alert.generation,
    };
    const key = `alert:${input.alertId}:round:${input.execute ? alert.round - 1 : alert.round}`;
    const existing = (
      await client.query<{
        id: string;
        approval: StagingAlertApproval;
        payload: Scope;
        generation: string;
        status: string;
      }>(
        `SELECT id::text,job_metadata->'stagingAlertRecovery' approval,payload,
       job_metadata#>>'{stagingImport,bindingGeneration}' generation,status
       FROM platform.jobs WHERE queue_name='pms.channex.webhooks' AND job_key=$1 FOR UPDATE`,
        [key],
      )
    ).rows[0];
    const approval: StagingAlertApproval = existing?.approval ?? {
      alertId: input.alertId,
      round: alert.round,
      canonicalBookingId: input.canonicalBookingId,
      approvalRef: input.approvalRef,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    if (
      existing &&
      (!existing.approval ||
        existing.generation !== scope.bindingGeneration ||
        existing.payload.propertyId !== propertyId ||
        existing.payload.providerPropertyId !== scope.providerPropertyId ||
        existing.payload.channelBookingId !== scope.channelBookingId ||
        existing.payload.revision !== scope.revision ||
        approval.canonicalBookingId !== input.canonicalBookingId ||
        approval.approvalRef !== input.approvalRef ||
        approval.alertId !== input.alertId)
    )
      throw new Error("staging_alert_scope_conflict");
    if (input.execute && !existing) throw new Error("staging_alert_not_prepared");
    // Completed job replays never call the provider again.
    if (input.execute && existing?.status === "succeeded") {
      await client.query("COMMIT");
      return { jobId: existing.id, status: "succeeded", replayed: true };
    }
    await assertStagingAlertApproval(
      client,
      scope,
      approval,
      input.execute ? existing!.id : undefined,
    );
    const persisted = (
      await client.query(
        `SELECT 1 FROM platform.jobs WHERE queue_name='pms.channex.webhooks'
      AND job_type='channex.ingest-booking' AND status='succeeded' AND payload->>'propertyId'=$1
      AND payload->>'providerPropertyId'=$2 AND payload->>'channelBookingId'=$3
      AND payload->>'revision'=$4 AND job_metadata#>>'{stagingImport,bindingGeneration}'=$5 LIMIT 1`,
        [
          propertyId,
          scope.providerPropertyId,
          scope.channelBookingId,
          scope.revision,
          scope.bindingGeneration,
        ],
      )
    ).rows.length;
    if (!persisted) throw new Error("completed_staging_import_required");
    const id =
      existing?.id ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,
       resource_id,correlation_id,payload,job_metadata,run_after,max_attempts)
       VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,$3,$4,$5,'infinity',5) RETURNING id::text`,
          [
            key,
            scope.channelBookingId,
            input.approvalRef,
            {
              ...scope,
              recoveryAlertId: input.alertId,
              revisionSource: "webhook_hint",
              pullRequired: true,
              rawPayload: { event: "booking" },
            },
            {
              stagingImport: { bindingGeneration: scope.bindingGeneration },
              stagingAlertRecovery: approval,
            },
          ],
        )
      ).rows[0]!.id;
    await client.query("COMMIT");
    if (!input.execute) return { jobId: id, status: "prepared", expiresAt: approval.expiresAt };
    await runChannexBookingJobs(config.targetDatabaseUrl, {
      apiBaseUrl: config.channexManagement.apiBaseUrl!,
      apiKey: config.channexManagement.apiKey!,
      ownsMutation: () => stagingAlertProperty(config) === propertyId,
      stagingImport: { ...scope, jobId: id, alertRecovery: approval },
      limit: 1,
      fetch: request,
    });
    const result = (
      await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts_count::int attempts FROM platform.jobs WHERE id=$1::uuid",
        [id],
      )
    ).rows[0]!;
    return { jobId: id, ...result };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
