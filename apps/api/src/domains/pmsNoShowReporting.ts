import pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";

export const NO_SHOW_QUEUE = "pms.channex.no_show";
type Db = Pick<pg.Pool, "query">;
export type NoShowSnapshot = {
  eligible: boolean;
  reason: string | null;
  localNoShow: boolean;
  status: "not_reported" | "pending" | "submitted" | "action_required";
  retryable: boolean;
  waivedFees: boolean | null;
};
export class NoShowReportingConflict extends Error {}
type Eligibility = {
  propertyId: string;
  channel: string;
  source: string;
  sourceId: string;
  lifecycle: string;
  roomCount: number;
  assignments: number;
  noShows: number;
  eligibleAssignments: number;
  mappingCount: number;
  mappingOwned: boolean;
  providerSources: boolean;
  externalBookingId: string | null;
  externalPropertyId: string | null;
  bindingGeneration: string | null;
  timezone: string | null;
  inWindow: boolean;
  checkIn: string;
  checkOut: string;
};
export type ReportJob = {
  id: string;
  property_id: string;
  resource_id: string;
  status: string;
  attempts_count: number;
  max_attempts: number;
  payload: {
    waivedFees: boolean;
    actorUserId: string;
    externalBookingId: string;
    externalPropertyId: string;
    bindingGeneration: string;
  };
  job_metadata: { dispatchStarted?: boolean; reason?: string; retryable?: boolean };
};

export async function loadNoShowEligibility(
  db: Db,
  propertyId: string,
  bookingId: string,
  now = new Date(),
) {
  return (
    await db.query<Eligibility>(
      `SELECT b.property_id::text AS "propertyId",b.booking_channel AS channel,b.source_system AS source,
    b.source_booking_id AS "sourceId",b.lifecycle_status AS lifecycle,b.room_count AS "roomCount",
    b.check_in::text AS "checkIn",b.check_out::text AS "checkOut",l.timezone,
    COALESCE($3::timestamptz >= (b.check_in::timestamp AT TIME ZONE tz.name)
      AND $3::timestamptz < (b.check_in::timestamp AT TIME ZONE tz.name) + interval '48 hours',false) AS "inWindow",
    c.external_property_id AS "externalPropertyId",c.binding_generation::text AS "bindingGeneration",
    (SELECT count(*)::int FROM pms.operational_booking_assignments a WHERE a.property_id=b.property_id AND a.guest_booking_id=b.id) AS assignments,
    (SELECT count(*)::int FROM pms.operational_booking_assignments a WHERE a.property_id=b.property_id AND a.guest_booking_id=b.id AND a.assignment_payload->>'operationalStatus'='no_show') AS "noShows",
    (SELECT count(*)::int FROM pms.operational_booking_assignments a WHERE a.property_id=b.property_id AND a.guest_booking_id=b.id AND (a.assignment_payload->>'operationalStatus'='no_show' OR (a.assignment_status IN ('assigned','pending') AND COALESCE(a.assignment_payload->>'operationalStatus','confirmed')='confirmed'))) AS "eligibleAssignments",
    (SELECT count(*)::int FROM pms.channel_booking_mappings m WHERE m.property_id=b.property_id AND m.guest_booking_id=b.id AND m.connection_id=c.id AND m.sync_status='active') AS "mappingCount",
    (SELECT CASE WHEN count(DISTINCT m.external_booking_id)=1 THEN min(m.external_booking_id) END FROM pms.channel_booking_mappings m WHERE m.property_id=b.property_id AND m.guest_booking_id=b.id AND m.connection_id=c.id AND m.sync_status='active') AS "externalBookingId",
    NOT EXISTS(SELECT 1 FROM pms.channel_booking_mappings m JOIN pms.channel_booking_mappings other ON other.connection_id=m.connection_id AND other.external_booking_id=m.external_booking_id WHERE m.property_id=b.property_id AND m.guest_booking_id=b.id AND (other.guest_booking_id<>b.id OR other.property_id<>b.property_id)) AS "mappingOwned",
    COALESCE((SELECT bool_and(COALESCE(regexp_replace(lower(m.mapping_metadata->>'providerSource'),'[^a-z0-9]','','g')='bookingcom' AND m.mapping_metadata->>'providerPropertyId'=c.external_property_id AND m.channel_room_index < b.room_count,false)) FROM pms.channel_booking_mappings m WHERE m.property_id=b.property_id AND m.guest_booking_id=b.id AND m.connection_id=c.id AND m.sync_status='active'),false) AS "providerSources"
    FROM booking.guest_bookings b
    LEFT JOIN hotel_catalog.property_locations l ON l.property_id=b.property_id
    LEFT JOIN pg_timezone_names tz ON tz.name=l.timezone
    LEFT JOIN pms.channel_connections c ON c.property_id=b.property_id AND c.provider='channex' AND c.connection_status='connected'
      AND EXISTS(SELECT 1 FROM pms.channel_binding_claims claim WHERE claim.property_id=c.property_id AND claim.provider='channex' AND claim.external_property_id=c.external_property_id AND claim.claim_state='active')
    WHERE b.property_id=$1::uuid AND b.id=$2::uuid`,
      [propertyId, bookingId, now.toISOString()],
    )
  ).rows[0];
}
export function noShowIneligibility(row: Eligibility): string | null {
  if (row.channel !== "booking_com" || row.source !== "pms")
    return "Only imported Booking.com reservations can be reported.";
  if (
    !row.externalBookingId ||
    !row.externalPropertyId ||
    !row.bindingGeneration ||
    !row.mappingOwned ||
    !row.providerSources ||
    row.mappingCount !== row.roomCount ||
    row.sourceId !== `channex:${row.propertyId}:${row.externalBookingId}`
  )
    return "The Booking.com reservation mapping is missing or inconsistent. Review it in the extranet.";
  if (
    row.lifecycle !== "confirmed" ||
    row.assignments !== row.roomCount ||
    row.eligibleAssignments !== row.roomCount ||
    (row.noShows > 0 && row.noShows !== row.roomCount)
  )
    return "Only a complete reservation that has not checked in can be reported. Partial no-shows require the extranet.";
  if (!row.timezone || !row.inWindow)
    return "Reporting is available from arrival-date midnight until 48 hours later in the property timezone. Otherwise use the extranet.";
  return null;
}
async function findJob(db: Db, propertyId: string, bookingId: string) {
  return (
    await db.query<ReportJob>(
      "SELECT * FROM platform.jobs WHERE queue_name=$1 AND property_id=$2::uuid AND resource_id=$3",
      [NO_SHOW_QUEUE, propertyId, bookingId],
    )
  ).rows[0];
}
export function reportSnapshot(row: Eligibility, job?: ReportJob): NoShowSnapshot {
  const reason = noShowIneligibility(row);
  return {
    eligible: !reason,
    reason: job?.job_metadata.reason ?? reason,
    localNoShow: row.noShows === row.roomCount && row.roomCount > 0,
    status: !job
      ? "not_reported"
      : job.status === "succeeded"
        ? "submitted"
        : ["pending", "running"].includes(job.status)
          ? "pending"
          : "action_required",
    retryable:
      !reason &&
      job?.job_metadata.retryable === true &&
      job.status === "dead_lettered" &&
      job.attempts_count < 15,
    waivedFees: job?.payload.waivedFees ?? null,
  };
}
export async function noShowAudit(db: Db, job: ReportJob, action: string) {
  await db.query(
    `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,job_id,redacted_payload)
    VALUES($1,'pms',$2,now(),'property',$3::uuid,'user',$4::uuid,'pms','reservation',$5,$6::uuid,$7::jsonb)
    ON CONFLICT(product,audit_key) DO NOTHING`,
    [
      `${job.id}:${job.attempts_count}:${action}`,
      `pms.no_show_report.${action}`,
      job.property_id,
      job.payload.actorUserId,
      job.resource_id,
      job.id,
      JSON.stringify({ ...job.payload, ...job.job_metadata }),
    ],
  );
}
export function createNoShowReportingStore(pool: pg.Pool) {
  return {
    async get(propertyId: string, bookingId: string) {
      const row = await loadNoShowEligibility(pool, propertyId, bookingId);
      return row ? reportSnapshot(row, await findJob(pool, propertyId, bookingId)) : null;
    },
    async submit(
      context: RequestContext,
      propertyId: string,
      bookingId: string,
      waivedFees: boolean,
      retry: boolean,
    ) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${NO_SHOW_QUEUE}:${propertyId}:${bookingId}`,
        ]);
        const row = await loadNoShowEligibility(db, propertyId, bookingId);
        if (!row) {
          await db.query("ROLLBACK");
          return null;
        }
        let job = await findJob(db, propertyId, bookingId);
        if (job && job.payload.waivedFees !== waivedFees)
          throw new NoShowReportingConflict(
            "The report already has a different fee choice. Review in the extranet.",
          );
        if (job && !retry) {
          await db.query("COMMIT");
          return reportSnapshot(row, job);
        }
        const reason = noShowIneligibility(row);
        if (reason || row.noShows !== row.roomCount)
          throw new NoShowReportingConflict(reason ?? "Record the full local no-show first.");
        if (job) {
          if (!reportSnapshot(row, job).retryable || job.job_metadata.dispatchStarted)
            throw new NoShowReportingConflict(
              "This outcome requires extranet review; resubmission is unsafe.",
            );
          job = (
            await db.query<ReportJob>(
              `UPDATE platform.jobs SET status='pending',finished_at=NULL,run_after=now(),max_attempts=LEAST(max_attempts+5,15),job_metadata='{}'::jsonb,
            payload=jsonb_set(payload,'{actorUserId}',to_jsonb($2::text)),updated_at=now() WHERE id=$1::uuid RETURNING *`,
              [job.id, context.actor.internalUserId],
            )
          ).rows[0]!;
        } else {
          if (retry) throw new NoShowReportingConflict("No reporting operation exists to retry.");
          job = (
            await db.query<ReportJob>(
              `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload)
            VALUES($1,$2,$2,'property',$3::uuid,'pms','reservation',$4,$5,$6::jsonb) RETURNING *`,
              [
                `${propertyId}:${bookingId}`,
                NO_SHOW_QUEUE,
                propertyId,
                bookingId,
                context.audit.correlationId ?? context.audit.requestId,
                JSON.stringify({
                  waivedFees,
                  actorUserId: context.actor.internalUserId,
                  externalBookingId: row.externalBookingId,
                  externalPropertyId: row.externalPropertyId,
                  bindingGeneration: row.bindingGeneration,
                }),
              ],
            )
          ).rows[0]!;
        }
        await noShowAudit(db, job, retry ? "retry_requested" : "accepted");
        await db.query("COMMIT");
        return reportSnapshot(row, job);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    },
  };
}
export type NoShowReportingStore = ReturnType<typeof createNoShowReportingStore>;
