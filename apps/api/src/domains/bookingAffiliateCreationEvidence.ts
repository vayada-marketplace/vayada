import type pg from "pg";

export type BookingAffiliateCreationEvidence =
  | {
      status: "pending";
      reason: "scope_unavailable" | "unsupported_source" | "creation_evidence_missing";
    }
  | { status: "needs_review"; reason: "conflicting_creation_evidence" }
  | {
      status: "recorded";
      propertyId: string;
      bookingId: string;
      originalBookedAt: string;
      source: "vayada_booking";
      creationEventId: string;
      requestId: string;
      correlationId: string | null;
    };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trace = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 256;

/** Booking-owned internal source read. Caller must authorize canonical property access
 * (including retries) before calling; no public route. The supplied clock is server-owned.
 * This proves only native creation provenance, never attribution, completion or revenue.
 */
export async function readBookingAffiliateCreationEvidence(
  database: Pick<pg.Pool, "query">,
  input: { propertyId: string; bookingId: string },
  now = new Date(),
): Promise<BookingAffiliateCreationEvidence> {
  if (![input.propertyId, input.bookingId].every((id) => typeof id === "string" && uuid.test(id)))
    return { status: "pending", reason: "scope_unavailable" };
  const propertyId = input.propertyId.toLowerCase(),
    bookingId = input.bookingId.toLowerCase();
  const result = await database.query(
    `SELECT b.source_system,b.source_booking_id,b.booking_channel,
      b.direct_booking_source,b.created_at,b.quote_session_id,b.checkout_context_id,
      e.id AS event_id,e.actor_type,e.occurred_at,e.event_payload->>'requestId' AS request_id,
      e.event_payload->>'correlationId' AS correlation_id,
      e.occurred_at=b.created_at AS creation_time_matches
    FROM booking.guest_bookings b
    JOIN hotel_catalog.properties p ON p.id=b.property_id AND p.profile_status <> 'disabled'
    LEFT JOIN booking.booking_status_events e ON e.guest_booking_id=b.id AND e.event_type='guest_booking.created'
    WHERE b.id=$1 AND b.property_id=$2 ORDER BY e.id LIMIT 2`,
    [bookingId, propertyId],
  );
  if (!result.rows.length) return { status: "pending", reason: "scope_unavailable" };
  const row = result.rows[0];
  if (
    row.source_system !== "booking" ||
    row.source_booking_id !== null ||
    row.booking_channel !== "direct" ||
    row.direct_booking_source !== "booking_engine"
  )
    return { status: "pending", reason: "unsupported_source" };
  if (!row.event_id || !row.quote_session_id || !row.checkout_context_id)
    return { status: "pending", reason: "creation_evidence_missing" };
  const instant = row.created_at instanceof Date ? row.created_at : new Date(NaN);
  if (
    result.rows.length !== 1 ||
    row.actor_type !== "guest" ||
    row.creation_time_matches !== true ||
    !trace(row.request_id) ||
    (row.correlation_id !== null && !trace(row.correlation_id)) ||
    !Number.isFinite(instant.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    instant.getTime() > now.getTime()
  )
    return { status: "needs_review", reason: "conflicting_creation_evidence" };
  return {
    status: "recorded",
    propertyId,
    bookingId,
    originalBookedAt: instant.toISOString(),
    source: "vayada_booking",
    creationEventId: row.event_id,
    requestId: row.request_id,
    correlationId: row.correlation_id,
  };
}
