import { randomUUID } from "node:crypto";
import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";
import type { PmsRoomClosureScope } from "./pmsRoomClosureState.js";

/** Correlated closure audit and durable Distribution refresh, in the closure transaction. */
export async function recordPmsRoomClosureEvents(
  client: DistributionBookingPublicationTransaction,
  scope: PmsRoomClosureScope,
  command: { idempotencyId: string; keyHash: string; requestId: string; correlationId?: string },
  result: { calendarRevision: number; cutoffDate: string; phase: "publication_refresh_required" },
  acceptedAt: Date,
): Promise<{ idempotencyId: string; domainEventId: string; outboxEventId: string }> {
  const domainEventId = randomUUID(),
    outboxEventId = randomUUID();
  const eventKey = `pms.room-type.closed:${scope.propertyId}:${command.idempotencyId}`;
  const correlation = command.correlationId ?? command.requestId;
  const payload = {
    ...result,
    propertyId: scope.propertyId,
    roomTypeId: scope.roomTypeId,
    commandId: command.idempotencyId,
  };
  await client.query(
    `INSERT INTO platform.domain_events
    (id,source_system,event_key,event_type,event_version,occurred_at,tenant_scope,property_id,
      resource_product,resource_type,resource_id,actor_type,actor_user_id,correlation_id,causation_id,
      idempotency_key_hash,payload,event_metadata,privacy_scope)
    VALUES ($1::uuid,'pms',$2,'pms.room_type.closed',1,$3::timestamptz,'property',$4::uuid,
      'pms','room_type',$5,'user',$6::uuid,$7,$8,$9,$10::jsonb,$11::jsonb,'confidential')`,
    [
      domainEventId,
      eventKey,
      acceptedAt.toISOString(),
      scope.propertyId,
      scope.roomTypeId,
      scope.actorUserId,
      correlation,
      command.requestId,
      command.keyHash,
      JSON.stringify(payload),
      JSON.stringify({ actorOrganizationId: scope.organizationId }),
    ],
  );
  await client.query(
    `INSERT INTO platform.outbox_events
    (id,domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,
      resource_type,resource_id,correlation_id,idempotency_key_hash,payload)
    VALUES ($1::uuid,$2::uuid,$3,'distribution.inventory-projection','pms.inventory.projection_refresh_requested',
      'property',$4::uuid,'pms','inventory',$4::text,$5,$6,$7::jsonb)`,
    [
      outboxEventId,
      domainEventId,
      `distribution.inventory-projection:${eventKey}`,
      scope.propertyId,
      correlation,
      command.keyHash,
      JSON.stringify({ ...payload, reason: "room_closure" }),
    ],
  );
  await client.query(
    `INSERT INTO platform.product_audit_events
    (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
      target_resource_product,target_resource_type,target_resource_id,domain_event_id,idempotency_key_id,
      correlation_id,causation_id,redacted_payload,private_payload,audit_metadata,privacy_scope)
    VALUES ($1,'pms','room_type.close',$2::timestamptz,'property',$3::uuid,'user',$4::uuid,
      'pms','room_type',$5,$6::uuid,$7::uuid,$8,$9,$10::jsonb,'{}'::jsonb,$11::jsonb,'confidential')`,
    [
      eventKey,
      acceptedAt.toISOString(),
      scope.propertyId,
      scope.actorUserId,
      scope.roomTypeId,
      domainEventId,
      command.idempotencyId,
      correlation,
      command.requestId,
      JSON.stringify(payload),
      JSON.stringify({ actorOrganizationId: scope.organizationId }),
    ],
  );
  return { idempotencyId: command.idempotencyId, domainEventId, outboxEventId };
}
