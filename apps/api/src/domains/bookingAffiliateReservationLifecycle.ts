import type { QueryResultRow } from "pg";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

type AffiliateReservationLifecycleEvent = {
  source: "booking" | "pms";
  eventKey: string;
  eventType:
    | "booking.affiliate_reservation.amended"
    | "booking.affiliate_reservation.canceled"
    | "pms.affiliate_reservation.completed";
  occurredAt: string;
  propertyId: string;
  bookingId: string;
  actorType: "user" | "system";
  actorUserId?: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKeyHash?: string;
  evidence: Record<string, unknown>;
};

/** Publish only for a live, immutable original binding. The caller's transaction
 * keeps the lifecycle mutation and its evidence atomic. */
export async function publishAffiliateReservationLifecycle(
  database: Queryable,
  event: AffiliateReservationLifecycleEvent,
): Promise<void> {
  await database.query(
    `INSERT INTO platform.domain_events
       (source_system,event_key,event_type,event_version,occurred_at,tenant_scope,property_id,
        resource_product,resource_type,resource_id,actor_type,actor_user_id,correlation_id,
        causation_id,idempotency_key_hash,payload,event_metadata,privacy_scope)
     SELECT $1,$2,$3,1,$4::timestamptz,'property',$5::uuid,
       'booking','affiliate_reservation',$6,$7,$8::uuid,$9,$10,$11,
       jsonb_build_object('bookingId',$6::text,'evidence',$12::jsonb),
       '{"contractVersion":"affiliate-reservation-lifecycle.v1","owner":"booking"}'::jsonb,
       'confidential'
     FROM booking.affiliate_original_booking_bindings binding
     WHERE binding.booking_id=$6::uuid AND binding.property_id=$5::uuid AND binding.synthetic=FALSE
     ON CONFLICT (source_system,event_key) DO NOTHING`,
    [
      event.source,
      event.eventKey,
      event.eventType,
      event.occurredAt,
      event.propertyId,
      event.bookingId,
      event.actorType,
      event.actorUserId ?? null,
      event.correlationId ?? null,
      event.causationId ?? null,
      event.idempotencyKeyHash ?? null,
      JSON.stringify(event.evidence),
    ],
  );
}
