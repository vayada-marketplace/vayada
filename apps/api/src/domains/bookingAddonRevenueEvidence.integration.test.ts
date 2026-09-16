import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendCheckoutAddonRevenueEvidence,
  BookingAddonRevenueEvidenceError,
} from "./bookingAddonRevenueEvidence.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname)) {
  throw new Error("Unsafe test database");
}

describe.skipIf(!URL)("PostgreSQL checkout add-on revenue evidence", () => {
  const client = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const propertyId = randomUUID();
  const guestBookingId = randomUUID();
  const exactSelectionId = randomUUID();
  const inferredSelectionId = randomUUID();
  const missingSelectionId = randomUUID();
  const supersededSelectionId = randomUUID();

  beforeAll(async () => {
    await client.connect();
    await client.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
       VALUES ($1::uuid,$1::text,'Checkout add-on evidence')`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
         (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,edit_revision)
       VALUES ($2::uuid,$1::uuid,$2::text,'confirmed','2026-08-15','2026-08-18','EUR',1)`,
      [propertyId, guestBookingId],
    );
    await client.query(
      `INSERT INTO booking.booking_addon_selections
         (id,property_id,guest_booking_id,service_date,quantity,total_amount,currency,
          ownership_kind_snapshot,partner_commission_rate_snapshot,edit_revision)
       VALUES
         ($3,$1,$2,'2026-08-17',2,30,'EUR','property',NULL,1),
         ($4,$1,$2,NULL,1,50,'EUR','partner',12.5,1),
         ($5,$1,$2,'2026-08-16',1,15,'EUR','property',NULL,1),
         ($6,$1,$2,'2026-08-15',1,99,'EUR','property',NULL,0)`,
      [
        propertyId,
        guestBookingId,
        exactSelectionId,
        inferredSelectionId,
        missingSelectionId,
        supersededSelectionId,
      ],
    );
  });

  afterAll(async () => {
    await client.query("BEGIN; SET LOCAL session_replication_role=replica");
    for (const table of [
      "booking.addon_revenue_evidence",
      "booking.booking_addon_selections",
      "booking.guest_bookings",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE property_id=$1::uuid`, [propertyId]);
    }
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1::uuid", [propertyId]);
    await client.query("COMMIT");
    await client.end();
  });

  it("recognizes only explicit active selections and records the rest as missing", async () => {
    await client.query("BEGIN");
    await appendCheckoutAddonRevenueEvidence(client, {
      propertyId,
      guestBookingId,
      fulfilledSelectionIds: [exactSelectionId, inferredSelectionId],
      commandKeyHash: "a".repeat(64),
    });
    await client.query("COMMIT");

    const result = await client.query(
      `SELECT addon_selection_id::text AS id,recognized_on::text AS date,gross_amount::text AS gross,
         economic_event AS event,evidence_quality AS quality
       FROM booking.addon_revenue_evidence WHERE property_id=$1::uuid ORDER BY id`,
      [propertyId],
    );
    expect(result.rows).toEqual(
      expect.arrayContaining([
        {
          id: exactSelectionId,
          date: "2026-08-17",
          gross: "30.0000",
          event: "fulfillment",
          quality: "exact",
        },
        {
          id: inferredSelectionId,
          date: "2026-08-15",
          gross: "50.0000",
          event: "fulfillment",
          quality: "inferred",
        },
        {
          id: missingSelectionId,
          date: "2026-08-16",
          gross: null,
          event: "missing_fulfillment",
          quality: "missing",
        },
      ]),
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.some(({ id }) => id === supersededSelectionId)).toBe(false);
  });

  it("rejects a selection outside the active booking revision without partial evidence", async () => {
    await client.query("BEGIN");
    try {
      await expect(
        appendCheckoutAddonRevenueEvidence(client, {
          propertyId,
          guestBookingId,
          fulfilledSelectionIds: [supersededSelectionId],
          commandKeyHash: "b".repeat(64),
        }),
      ).rejects.toBeInstanceOf(BookingAddonRevenueEvidenceError);
    } finally {
      await client.query("ROLLBACK");
    }
    const count = await client.query(
      "SELECT count(*)::int count FROM booking.addon_revenue_evidence WHERE property_id=$1::uuid AND command_key LIKE 'pms-checkout:b%'",
      [propertyId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });
});
