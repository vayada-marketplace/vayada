import { createHash } from "node:crypto";
import type { PmsPricingCommandClient } from "./pmsPricingCommandRepository.js";

export async function enqueueChannexMealChange(
  client: PmsPricingCommandClient,
  input: {
    propertyId: string;
    ratePlanId: string;
    eventId: string;
    actorUserId: string;
    correlationId: string;
  },
): Promise<void> {
  const key = `channex.meals:${input.eventId}`;
  await client.query(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, status, max_attempts, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, payload, job_metadata
     ) SELECT $1, 'pms.channex.management', 'channex.provision', 'pending', 5,
       'property', connection.property_id, 'pms', 'channex_connection', $2::uuid::text, $3, $4,
       $5::jsonb, jsonb_build_object('sourceEventId', $6::text, 'mealReconciliation', true)
     FROM pms.channel_connections connection
     WHERE connection.property_id = $2::uuid AND connection.provider = 'channex'
       AND connection.external_property_id IS NOT NULL AND connection.connection_status IN ('connected', 'degraded')
     ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [
      key,
      input.propertyId,
      input.correlationId,
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify({
        commandId: input.eventId,
        idempotencyKey: key,
        operationType: "provision",
        mealRatePlanId: input.ratePlanId,
        actorUserId: input.actorUserId,
      }),
      input.eventId,
    ],
  );
}
