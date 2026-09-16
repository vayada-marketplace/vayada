import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";
import { getTimezone } from "countries-and-timezones";
import { hasBookingFinancialEvidence } from "./financeBookingAlterationGuard.js";

/** Caller holds the booking FOR UPDATE lock through decision send or revision commit. */
export async function assertChannexUnverifiedAlterationSupport(
  client: ExternalRevenueEvidenceClient,
  scope: { propertyId: string; bookingId: string; providerBookingId: string },
): Promise<void> {
  const supported = await client.query(
    `SELECT 1 FROM booking.guest_bookings booking
     WHERE booking.id=$2 AND booking.property_id=$1 AND booking.booking_channel='airbnb'
       AND booking.source_system='pms' AND booking.source_booking_id=$3
       AND booking.booking_metadata->>'airbnbMoneyStatus'='unverified'
       AND booking.payment_status='unpaid'
       AND NOT EXISTS(SELECT 1 FROM finance.airbnb_provider_snapshots snapshot
         WHERE snapshot.property_id=$1 AND snapshot.guest_booking_id=$2)
       AND NOT EXISTS(SELECT 1 FROM booking.nightly_revenue_evidence revenue
         WHERE revenue.property_id=$1 AND revenue.guest_booking_id=$2
           AND revenue.economic_event='retained_charge')`,
    [scope.propertyId, scope.bookingId, `channex:${scope.propertyId}:${scope.providerBookingId}`],
  );
  if (!supported.rows.length || (await hasBookingFinancialEvidence(client, scope, true)))
    throw new Error("alteration_finance_reconciliation_required");
  const profile = await client.query<{ timeZone: string }>(
    `SELECT location.timezone AS "timeZone" FROM hotel_catalog.properties property
     JOIN hotel_catalog.property_locations location ON location.property_id=property.id
     JOIN pg_timezone_names zone ON zone.name=location.timezone
     WHERE property.id=$1 AND EXISTS(SELECT 1 FROM pms.operating_calendar_revisions calendar
       WHERE calendar.property_id=property.id
         AND calendar.calendar_revision=(SELECT max(calendar_revision)
           FROM pms.operating_calendar_revisions WHERE property_id=property.id)
         AND calendar.property_profile_revision=property.profile_revision
         AND calendar.property_time_zone=location.timezone)
     FOR SHARE OF property,location`,
    [scope.propertyId],
  );
  const timeZone = profile.rows[0]?.timeZone;
  const zone = timeZone && getTimezone(timeZone);
  if (!zone || zone.name !== timeZone || zone.aliasOf !== null)
    throw new Error("alteration_finance_reconciliation_required");
}
