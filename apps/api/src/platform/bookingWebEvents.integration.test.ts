import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBookingWebEventSink } from "./bookingWebEvents.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const slug = "vay-2215-click-hotel";

describe.skipIf(!TEST_DATABASE_URL)("Affiliate click storage on PostgreSQL (VAY-2215)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });

  beforeAll(async () => {
    const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
      throw new Error("Unsafe test database");
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  it("stores no page address, referrer, metadata, request id or visitor hashes in the event or its audit row", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: TEST_DATABASE_URL!, max: 1 });
    const click = {
      clickId: "vay-2215-click",
      slug,
      referralCode: "REF-2215",
      sessionId: "vay-2215-session",
      referrerSource: "instagram" as const,
      occurredAt: new Date("2027-01-01T10:00:00.000Z"),
      userAgent: "Mozilla/5.0 Safari/605.1.15",
    };
    await sink.recordAffiliateClick(click);
    await sink.recordAffiliateClick(click);

    const payload = {
      clickId: "vay-2215-click",
      hotelSlug: slug,
      referralCode: "REF-2215",
      sessionId: "vay-2215-session",
      referrerSource: "instagram",
    };
    const metadata = { source: "apps/api-booking-web-public", trafficClass: "human" };
    const stored = await admin.query(
      `SELECT event.payload, event.event_metadata, event.tenant_scope, event.property_id,
              event.correlation_id, audit.correlation_id AS audit_correlation_id,
              audit.redacted_payload, audit.private_payload, audit.audit_metadata
       FROM platform.domain_events event
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       WHERE event.event_type = 'marketplace.affiliate_click.recorded'
         AND event.payload->>'hotelSlug' = $1`,
      [slug],
    );
    expect(stored.rows).toEqual([
      {
        payload,
        event_metadata: metadata,
        tenant_scope: "external",
        property_id: null,
        correlation_id: "vay-2215-session",
        audit_correlation_id: "vay-2215-session",
        redacted_payload: payload,
        private_payload: {},
        audit_metadata: metadata,
      },
    ]);
  });

  async function cleanup(): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM platform.product_audit_events
         WHERE product = 'marketplace' AND action = 'affiliate_click.recorded'
           AND redacted_payload->>'hotelSlug' = $1`,
        [slug],
      );
      await client.query(
        `DELETE FROM platform.domain_events
         WHERE event_type = 'marketplace.affiliate_click.recorded'
           AND payload->>'hotelSlug' = $1`,
        [slug],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
