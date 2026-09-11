import type { QueryResult, QueryResultRow } from "pg";

type Executor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

/** Called only under the settlement transaction's booking lock, before leaving draft.
 * Missing original provenance stays unavailable; never backfill from an edited quote.
 * This stores unclassified price evidence, not hotel acceptance or collected revenue.
 */
export async function preserveCardDraftChargeSnapshot(
  client: Executor,
  propertyId: string,
  bookingId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO booking.original_charge_snapshots
    (booking_id,property_id,quote_id,contract_version,classification_status,currency,totals,selected_offer,request_id)
    SELECT b.id,b.property_id,q.id,'native-checkout-charge.v1','unclassified',q.currency,
      q.totals,q.selected_offer_snapshot,e.event_payload->>'requestId'
    FROM booking.guest_bookings b
    JOIN booking.checkout_contexts c ON c.id=b.checkout_context_id AND c.property_id=b.property_id AND c.quote_session_id=b.quote_session_id
    JOIN booking.quote_sessions q ON q.id=c.quote_session_id AND q.property_id=b.property_id
    JOIN booking.booking_status_events e ON e.guest_booking_id=b.id AND e.event_type='guest_booking.created'
    WHERE b.id=$1 AND b.property_id=$2 AND b.lifecycle_status='draft' AND b.edit_revision=0
      AND b.source_system='booking' AND b.source_booking_id IS NULL
      AND b.booking_channel='direct' AND b.direct_booking_source='booking_engine'
      AND b.booking_metadata->>'paymentMethod'='card'
      AND b.booking_metadata->>'quoteReference'=q.public_quote_reference
      AND q.status='converted' AND c.status='converted' AND q.currency=b.currency
      AND e.actor_type='guest' AND e.occurred_at=b.created_at
      AND length(btrim(e.event_payload->>'requestId')) BETWEEN 1 AND 200
      AND NOT EXISTS(SELECT 1 FROM booking.booking_status_events other
        WHERE other.guest_booking_id=b.id AND other.event_type='guest_booking.created' AND other.id<>e.id)
    ON CONFLICT (booking_id) DO NOTHING`,
    [bookingId, propertyId],
  );
}
