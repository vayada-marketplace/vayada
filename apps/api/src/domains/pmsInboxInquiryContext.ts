import type { QueryResultRow } from "pg";
import {
  airbnbInquiryEvidenceSchema,
  type AirbnbInquiryEvidence,
} from "./airbnbInquiryEvidence.js";

/** Called under the thread lock for writes, and without a lock for presentation.
 * A newer incomplete inquiry invalidates older evidence instead of falling back. */
export async function readPmsInboxInquiryContext(
  client: {
    query<T extends QueryResultRow>(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  },
  propertyId: string,
  threadId: string,
  expectedVersion?: number,
): Promise<AirbnbInquiryEvidence | null> {
  const { rows } = await client.query<{
    evidence: unknown;
    providerPropertyId: string;
    sourceThreadId: string;
    arrivalDate: string;
    departureDate: string;
    adults: number;
    children: number;
  }>(
    `
    SELECT message.raw_payload->'airbnbInquiry' AS evidence,
      connection.external_property_id AS "providerPropertyId", thread.source_thread_id AS "sourceThreadId",
      thread.inquiry_arrival_date::text AS "arrivalDate", thread.inquiry_departure_date::text AS "departureDate",
      thread.inquiry_adults AS adults, thread.inquiry_children AS children
    FROM pms.message_threads thread
    JOIN pms.channel_connections connection ON connection.property_id = thread.property_id
      AND connection.provider = 'channex' AND connection.connection_status IN ('connected', 'degraded')
      AND connection.messaging_app_installed
    JOIN pms.channel_binding_claims claim ON claim.property_id = connection.property_id
      AND claim.provider = 'channex' AND claim.external_property_id = connection.external_property_id
      AND claim.claim_state = 'active'
    JOIN LATERAL (SELECT raw_payload FROM pms.messages
      WHERE property_id = thread.property_id AND thread_id = thread.id
        AND raw_payload->>'inquiry' = 'true'
      ORDER BY sent_at DESC, id DESC LIMIT 1) message ON true
    WHERE thread.property_id = $1 AND thread.id = $2 AND thread.source = 'channex'
      AND thread.delivery_channel = 'ota' AND thread.provider_channel = 'airbnb'
      AND thread.conversation_context_state = 'inquiry' AND thread.guest_booking_id IS NULL
      AND ($3::bigint IS NULL OR thread.version = $3)`,
    [propertyId, threadId, expectedVersion ?? null],
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const result = airbnbInquiryEvidenceSchema.safeParse(row.evidence);
  if (!result.success) return null;
  const e = result.data;
  if (
    e.providerPropertyId !== row.providerPropertyId ||
    e.threadId !== row.sourceThreadId ||
    e.arrivalDate !== row.arrivalDate ||
    e.departureDate !== row.departureDate ||
    e.adults !== row.adults ||
    e.children !== row.children
  )
    return null;
  return e;
}
