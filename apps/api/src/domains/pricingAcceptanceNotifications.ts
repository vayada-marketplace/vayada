import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import type { storePricingAcceptance } from "./storePricingAcceptance.js";

/** Internal notification staging after immutable acceptance on the SAME retained
 * transaction. Uses existing jobs/events/audit; never calls an email provider.
 * Caller must finish PMS handoff/other writes and the final quote/Finance gate,
 * or roll back ALL changes. This is neither public acceptance nor permission to commit. */
export async function stagePricingAcceptanceNotifications(
  client: PoolClient,
  slug: unknown,
  accepted: Awaited<ReturnType<typeof storePricingAcceptance>>,
) {
  const fail = (): never => {
    throw new Error("Booking notifications unavailable");
  };
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return fail();
  const row = (
    await client.query(
      `SELECT a.*,b.lifecycle_status,b.payment_status,b.edit_revision,b.booking_metadata,
    b.currency,b.total_amount::text,b.balance_amount::text
    FROM booking.pricing_quote_acceptances a JOIN booking.guest_bookings b
      ON b.id=a.guest_booking_id AND b.property_id=a.property_id
    WHERE a.id=$1 AND a.guest_booking_id=$2 AND a.property_id=$3 AND a.organization_id=$4
    FOR UPDATE OF b`,
      [accepted.acceptanceId, accepted.bookingId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const iso = (v: unknown) =>
    v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v;
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
  const scale = history ? pricingCurrencyScale(history.quote.stay.currency) : null;
  if (
    !history ||
    scale === null ||
    row.currency !== history.quote.stay.currency ||
    pricingDecimalMinor(row.total_amount, scale) !== history.quote.evidence.totalMinor ||
    pricingDecimalMinor(row.balance_amount, scale) !== history.quote.evidence.totalMinor ||
    history.acceptedAt !== accepted.acceptedAt ||
    history.quote.acceptanceMode !== "instant" ||
    history.quote.paymentMethod !== "pay_at_property" ||
    row.lifecycle_status !== "confirmed" ||
    row.payment_status !== "unpaid" ||
    row.edit_revision !== 0 ||
    row.booking_metadata?.targetSource !== "pricing_quote_draft" ||
    row.booking_metadata.pricingQuoteId !== history.quote.quoteId ||
    row.booking_metadata.requestFingerprint !== history.fingerprint
  )
    return fail();
  const jobs = await enqueueBookingTransitionNotifications(client, {
    propertyId: scope.propertyId,
    guestBookingId: history.bookingId,
    occurredAt: history.acceptedAt,
    correlationId: history.command.requestId,
    causationId: history.command.requestId,
    actor: { type: "system" },
    source: "apps/api-replacement-booking-acceptance",
    transition: {
      eventType: "guest_booking.created",
      fromStatus: "draft",
      toStatus: "confirmed",
      revision: history.id,
    },
  });
  // The existing queue tolerates missing guest addresses; acceptance must not.
  const guestJobs = (
    await client.query(
      `SELECT payload FROM platform.jobs WHERE id=ANY($1::uuid[]) AND property_id=$2
    AND resource_product='booking' AND resource_type='guest_booking' AND resource_id=$3
    AND payload->>'recipientRole'='guest'`,
      [jobs.map((j) => j.jobId), scope.propertyId, history.bookingId],
    )
  ).rows;
  if (
    guestJobs.length !== 1 ||
    guestJobs[0].payload.to !== history.command.guest.email ||
    guestJobs[0].payload.notificationType !== "final_confirmation" ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)
  )
    return fail();
  return { bookingId: history.bookingId, jobs };
}
