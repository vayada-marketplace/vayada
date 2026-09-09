import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";

/** Caller holds the booking FOR UPDATE lock until its transaction commits. */
export async function hasBookingFinancialEvidence(
  client: ExternalRevenueEvidenceClient,
  scope: { propertyId: string; bookingId: string },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM booking.finance_nightly_revenue_evidence
       WHERE property_id=$1 AND guest_booking_id=$2
     UNION ALL SELECT 1 FROM finance.payments WHERE property_id=$1 AND guest_booking_id=$2
     UNION ALL SELECT 1 FROM finance.folios WHERE property_id=$1 AND guest_booking_id=$2
     LIMIT 1`,
    [scope.propertyId, scope.bookingId],
  );
  return result.rows.length > 0;
}
