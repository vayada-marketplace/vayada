import pg from "pg";

import type {
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

export function classifyBookingWebTraffic(userAgent: string | undefined): "bot" | "human" {
  return userAgent &&
    /(bot(?:\b|\/)|crawler|spider|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot)/i.test(
      userAgent,
    )
    ? "bot"
    : "human";
}
