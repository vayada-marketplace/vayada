import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { loadAcceptedPricingReservation } from "./pricingPmsAcceptedReservation.js";
import type { storePricingAcceptance } from "./storePricingAcceptance.js";

export const PMS_ACCEPTED_PRICING_QUEUE = "pms-reservation-handoff";
export const PMS_ACCEPTED_PRICING_JOB_TYPE = "pms.reservation.accepted-pricing.create";
export const PMS_ACCEPTED_PRICING_JOB_VERSION = "booking.pricing-pms-handoff.v1";

export async function stagePmsAcceptedPricingReservationJob(
  client: PoolClient,
  slug: unknown,
  accepted: Awaited<ReturnType<typeof storePricingAcceptance>>,
) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope || !accepted) throw new Error("PMS accepted-pricing job unavailable");
  const command = await loadAcceptedPricingReservation(client, {
    acceptanceId: accepted.acceptanceId,
    guestBookingId: accepted.bookingId,
    propertyId: scope.propertyId,
  });
  if (
    !command ||
    command.organizationId !== scope.organizationId ||
    command.acceptedAt !== accepted.acceptedAt
  )
    throw new Error("PMS accepted-pricing job unavailable");
  const payload = {
    version: PMS_ACCEPTED_PRICING_JOB_VERSION,
    propertyId: scope.propertyId,
    guestBookingId: accepted.bookingId,
    acceptanceId: accepted.acceptanceId,
  };
  const jobKey = `pms:pricing-acceptance:${accepted.acceptanceId}:create:v1`;
  const inserted = await client.query<{ jobId: string }>(
    `INSERT INTO platform.jobs
     (job_key,queue_name,job_type,status,max_attempts,tenant_scope,property_id,
      resource_product,resource_type,resource_id,correlation_id,payload)
     VALUES($1,$2,$3,'pending',5,'property',$4::uuid,'booking',
       'guest_booking',$5,$6,$7::jsonb)
     ON CONFLICT(queue_name,job_key) DO NOTHING RETURNING id::text AS "jobId"`,
    [
      jobKey,
      PMS_ACCEPTED_PRICING_QUEUE,
      PMS_ACCEPTED_PRICING_JOB_TYPE,
      scope.propertyId,
      accepted.bookingId,
      command.acceptanceId,
      JSON.stringify(payload),
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const replay = (
    await client.query<{ jobId: string; payload: unknown }>(
      `SELECT id::text AS "jobId",payload FROM platform.jobs
       WHERE queue_name=$1 AND job_key=$2 AND job_type=$3 AND tenant_scope='property'
         AND property_id=$4::uuid AND resource_product='booking'
         AND resource_type='guest_booking' AND resource_id=$5
         AND correlation_id=$6 AND max_attempts=5 FOR UPDATE`,
      [
        PMS_ACCEPTED_PRICING_QUEUE,
        jobKey,
        PMS_ACCEPTED_PRICING_JOB_TYPE,
        scope.propertyId,
        accepted.bookingId,
        command.acceptanceId,
      ],
    )
  ).rows[0];
  if (!replay || !isDeepStrictEqual(replay.payload, payload))
    throw new Error("PMS accepted-pricing job conflict");
  return { jobId: replay.jobId };
}
