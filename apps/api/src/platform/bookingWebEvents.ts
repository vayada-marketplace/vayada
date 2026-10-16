import crypto from "node:crypto";

import pg from "pg";

import type {
  BookingWebAffiliateClickEvent,
  BookingWebAttributionSink,
  BookingWebTelemetryEvent,
} from "../routes/bookingWebPublic.js";

type PgBookingWebEventSinkConfig = {
  connectionString: string;
  max?: number;
};

export function createPgBookingWebEventSink(
  config: PgBookingWebEventSinkConfig,
): BookingWebAttributionSink {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async recordAffiliateClick(event) {
      // Old callers have no retry identity; never collapse their whole session.
      const clickId = event.clickId ?? crypto.randomUUID();
      await insertDomainEventWithAudit(pool, {
        sourceSystem: "marketplace",
        eventKey: eventKey(
          "booking-web",
          "affiliate-click-v2",
          event.slug,
          event.referralCode,
          clickId,
        ),
        eventType: "marketplace.affiliate_click.recorded",
        occurredAt: event.occurredAt,
        resourceProduct: "marketplace",
        resourceType: "affiliate_referral",
        resourceId: `${event.slug}:${event.referralCode}`,
        correlationId: event.sessionId ?? clickId,
        idempotencyKeyHash: hashKey(event.slug, event.referralCode, clickId),
        payload: {
          clickId,
          hotelSlug: event.slug,
          referralCode: event.referralCode,
          sessionId: event.sessionId ?? null,
          referrerSource: event.referrerSource,
        },
        // VAY-2215: no request id (it joins the access log's IP address) and no IP or
        // user-agent hash; attribution needs none of them.
        eventMetadata: {
          source: "apps/api-booking-web-public",
          trafficClass: classifyBookingWebTraffic(event.userAgent),
        },
        auditProduct: "marketplace",
        auditAction: "affiliate_click.recorded",
        auditTargetProduct: "marketplace",
        auditTargetType: "affiliate_referral",
        auditTargetId: `${event.slug}:${event.referralCode}`,
      });
    },
    async recordTelemetryEvent(event) {
      // VAY-2212: funnel analytics live in their own table, which the API prunes after 13
      // months, not in the append-only event log. Bots are not stored; the readers never count
      // them (VAY-2214). No slug, request id, IP or user-agent trace is kept.
      if (classifyBookingWebTraffic(event.userAgent) === "bot") return;
      await pool.query(
        `INSERT INTO distribution.booking_web_events
           (property_id, event_type, event_id, session_id, metadata, occurred_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6)
         ON CONFLICT (property_id, event_id) DO NOTHING`,
        [
          event.propertyId,
          event.eventType,
          event.eventId,
          event.sessionId,
          JSON.stringify(event.metadata),
          event.occurredAt,
        ],
      );
    },
  };
}

type InsertEventInput = {
  propertyId?: string;
  sourceSystem: "marketplace" | "distribution";
  eventKey: string;
  eventType: string;
  occurredAt: Date;
  resourceProduct: "marketplace" | "distribution";
  resourceType: string;
  resourceId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  payload: Record<string, unknown>;
  eventMetadata: Record<string, unknown>;
  auditProduct: "marketplace" | "distribution";
  auditAction: string;
  auditTargetProduct: "marketplace" | "distribution";
  auditTargetType: string;
  auditTargetId: string;
};

async function insertDomainEventWithAudit(pool: pg.Pool, input: InsertEventInput): Promise<void> {
  const tenantScope = input.propertyId ? "property" : "external";
  await pool.query(
    `WITH inserted_event AS (
       INSERT INTO platform.domain_events
         (
           source_system,
           event_key,
           event_type,
           occurred_at,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           actor_type,
           correlation_id,
           idempotency_key_hash,
           payload,
           event_metadata,
           privacy_scope
         )
       VALUES
         ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, 'provider', $10, $11, $12, $13, 'internal')
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id
     ),
     selected_event AS (
       SELECT id FROM inserted_event
       UNION ALL
       SELECT id
       FROM platform.domain_events
       WHERE source_system = $1
         AND event_key = $2
       LIMIT 1
     )
     INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         property_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         domain_event_id,
         correlation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       (
         $14,
         $15,
         $16,
         $4,
         $5,
         $6::uuid,
         'provider',
         $17,
         $18,
         $19,
         (SELECT id FROM selected_event),
         $10,
         $12,
         '{}'::jsonb,
         $13,
         'standard',
         'internal'
       )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.sourceSystem,
      input.eventKey,
      input.eventType,
      input.occurredAt,
      tenantScope,
      input.propertyId ?? null,
      input.resourceProduct,
      input.resourceType,
      input.resourceId,
      input.correlationId,
      input.idempotencyKeyHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.eventMetadata),
      input.eventKey,
      input.auditProduct,
      input.auditAction,
      input.auditTargetProduct,
      input.auditTargetType,
      input.auditTargetId,
    ],
  );
}

function eventKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function hashKey(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

export function classifyBookingWebTraffic(userAgent: string | undefined): "bot" | "human" {
  return userAgent &&
    /(bot(?:\b|\/)|crawler|spider|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot)/i.test(
      userAgent,
    )
    ? "bot"
    : "human";
}
