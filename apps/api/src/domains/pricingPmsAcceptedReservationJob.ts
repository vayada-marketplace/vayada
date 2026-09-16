import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { projectAcceptedPricingReservation } from "./pricingPmsAcceptedReservation.js";
import type { storePricingAcceptance } from "./storePricingAcceptance.js";

export const PMS_ACCEPTED_PRICING_QUEUE = "pms.accepted-pricing";
export const PMS_ACCEPTED_PRICING_JOB_TYPE = "pms.accepted-pricing.adopt";
export const PMS_ACCEPTED_PRICING_JOB_VERSION = "pms-accepted-pricing-job.v1";

export async function stagePmsAcceptedPricingReservationJob(
  client: PoolClient,
  slug: unknown,
  accepted: Awaited<ReturnType<typeof storePricingAcceptance>>,
) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope || !accepted) throw new Error("PMS accepted-pricing job unavailable");
  const row = (
    await client.query(
      `SELECT * FROM booking.pricing_quote_acceptances
       WHERE id=$1::uuid AND guest_booking_id=$2::uuid AND property_id=$3::uuid
         AND organization_id=$4::uuid`,
      [accepted.acceptanceId, accepted.bookingId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const history =
    row &&
    decodePricingAcceptanceHistory(
      {
        ...row,
        accepted_at: iso(row.accepted_at),
        finance_terms_captured_at: iso(row.finance_terms_captured_at),
      },
      scope.propertyId,
      scope.organizationId,
    );
  const command = history && projectAcceptedPricingReservation(history);
  if (
    !history ||
    !command ||
    history.bookingId !== accepted.bookingId ||
    history.acceptedAt !== accepted.acceptedAt
  )
    throw new Error("PMS accepted-pricing job unavailable");
  const payload = { contractVersion: PMS_ACCEPTED_PRICING_JOB_VERSION, command };
  const jobKey = `accepted-pricing:${history.id}`;
  const inserted = await client.query<{ jobId: string }>(
    `INSERT INTO platform.jobs
     (job_key,queue_name,job_type,status,max_attempts,tenant_scope,property_id,
      resource_product,resource_type,resource_id,correlation_id,payload)
     VALUES($1,$2,$3,'pending',5,'property',$4::uuid,'pms',
       'accepted_pricing_reservation',$5,$6,$7::jsonb)
     ON CONFLICT(queue_name,job_key) DO NOTHING RETURNING id::text AS "jobId"`,
    [
      jobKey,
      PMS_ACCEPTED_PRICING_QUEUE,
      PMS_ACCEPTED_PRICING_JOB_TYPE,
      scope.propertyId,
      history.bookingId,
      history.command.requestId,
      JSON.stringify(payload),
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const replay = (
    await client.query<{ jobId: string; payload: unknown }>(
      `SELECT id::text AS "jobId",payload FROM platform.jobs
       WHERE queue_name=$1 AND job_key=$2 AND property_id=$3::uuid FOR UPDATE`,
      [PMS_ACCEPTED_PRICING_QUEUE, jobKey, scope.propertyId],
    )
  ).rows[0];
  if (!replay || !isDeepStrictEqual(replay.payload, payload))
    throw new Error("PMS accepted-pricing job conflict");
  return { jobId: replay.jobId };
}
