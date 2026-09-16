import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";

/** Caller holds the booking FOR UPDATE lock until its transaction commits. */
export async function hasBookingFinancialEvidence(
  client: ExternalRevenueEvidenceClient,
  scope: { propertyId: string; bookingId: string },
  allowLinkedOtaRevenue = false,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM booking.finance_nightly_revenue_evidence revenue
       WHERE property_id=$1 AND guest_booking_id=$2 AND (NOT $3::boolean OR source_kind<>'ota'
         OR NOT EXISTS(SELECT 1 FROM finance.ota_commission_evidence commission
           WHERE commission.booking_revenue_evidence_id=revenue.evidence_id AND commission.property_id=$1 AND commission.guest_booking_id=$2))
     UNION ALL SELECT 1 FROM finance.payments WHERE property_id=$1 AND guest_booking_id=$2
     UNION ALL SELECT 1 FROM finance.folios WHERE property_id=$1 AND guest_booking_id=$2
     LIMIT 1`,
    [scope.propertyId, scope.bookingId, allowLinkedOtaRevenue],
  );
  return result.rows.length > 0;
}
