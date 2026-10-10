import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
  PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
} from "@vayada/domain-pms";
import { createBookingHostActions, type HostActionScope } from "./bookingHostActions.js";
import { targetBookingHostActionGuards } from "./bookingHostActionGuards.js";
import {
  captureDirectNightlyRevenueEvidence,
  persistDirectNightlyRevenueProjection,
} from "./stripeBookingSettlement.js";

const url = process.env["TEST_DATABASE_URL"];
// A pricing-v2 booking records its nights from the accepted quote and keeps no
// `selectedOffer`. Cancelling, declining or expiring it must still reverse those nights.
describe.skipIf(!url)("pricing-v2 revenue clearing (PostgreSQL)", () => {
  const pool = new pg.Pool({ connectionString: url });
  let scope: HostActionScope;
  let released: unknown[] = [];
  const actions = createBookingHostActions({
    pool,
    now: () => new Date("2026-09-06T10:00:00Z"),
    guards: targetBookingHostActionGuards,
    inventory: {
      reserve: async () => null,
      async release({ reservation }) {
        released.push(reservation);
      },
    },
  });
  const roomTypes = [randomUUID(), randomUUID()];
  const metadata = () => ({
    targetSource: "pricing_quote_draft",
    pricingQuoteId: randomUUID(),
    acceptanceMode: "instant",
    paymentMethod: "pay_at_property",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    pricingSelections: roomTypes.map((roomTypeId, i) => ({
      selectionId: `room-${i + 1}`,
      roomTypeId,
      offerId: randomUUID(),
      guests: { adults: 2, childAgesAtCheckIn: [] },
    })),
    inventoryReservation: {
      contractVersion: PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
      owner: "pms",
      receipts: roomTypes.map(() => ({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        owner: "pms",
        receiptId: randomUUID(),
      })),
    },
  });
  const booking = () => ({
    guestBookingId: scope.bookingId,
    propertyId: scope.propertyId,
    checkIn: "2026-09-12",
    checkOut: "2026-09-14",
  });
  const nights = async () =>
    (
      await pool.query(
        `SELECT room_type_id::text AS room,stay_date::text AS date,sum(occupied_room_nights)::int AS occupied,
           sum(gross_room_amount)::text AS amount,count(*)::int AS rows
         FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1
         GROUP BY room_type_id,stay_date ORDER BY stay_date,amount`,
        [scope.bookingId],
      )
    ).rows;

  beforeEach(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Unsafe test database");
    released = [];
    scope = { propertyId: randomUUID(), bookingId: randomUUID(), actorUserId: randomUUID() };
    await pool.query(`INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')`, [
      scope.actorUserId,
      `${scope.actorUserId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$2,'Pricing clear test')`,
      [scope.propertyId, scope.propertyId],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,room_count,
        total_amount,balance_amount,booking_metadata)
      VALUES ($1,$2,$3,'confirmed','2026-09-12','2026-09-14','EUR',2,360,360,$4::jsonb)`,
      [scope.bookingId, scope.propertyId, scope.bookingId, JSON.stringify(metadata())],
    );
    await pool.query(
      `INSERT INTO booking.booking_guests (guest_booking_id,guest_role,first_name,last_name,email) VALUES ($1,'booker','Guest','Test','guest@example.test')`,
      [scope.bookingId],
    );
    // What stagePricingBookingRevenue records: one row per room and night, each with its room type.
    await persistDirectNightlyRevenueProjection(pool, booking(), {
      roomTypeId: roomTypes[0],
      nights: ["2026-09-12", "2026-09-13"].flatMap((stayDate) =>
        roomTypes.map((roomTypeId, i) => ({
          stayDate,
          grossRoomAmount: i ? "80.00" : "100.00",
          roomTypeId,
          roomPositions: [i + 1],
        })),
      ),
      fingerprint: "pricing-room-revenue.v1:test",
    });
  });
  afterAll(() => actions.close());

  it("reverses every room night without a booked offer, once", async () => {
    await pool.query(`UPDATE booking.guest_bookings SET lifecycle_status='canceled' WHERE id=$1`, [
      scope.bookingId,
    ]);
    const clear = () =>
      captureDirectNightlyRevenueEvidence(
        pool,
        { ...booking(), bookingMetadata: metadata() },
        { clear: true, fingerprint: "test-clear", recognizedOn: "2026-09-06", required: true },
      );
    await clear();
    await clear();
    expect(await nights()).toEqual(
      ["2026-09-12", "2026-09-13"].flatMap((date) =>
        [roomTypes[1], roomTypes[0]].map((room) => ({
          room,
          date,
          occupied: 0,
          amount: "0.0000",
          rows: 2,
        })),
      ),
    );
    const reversals = await pool.query(
      `SELECT DISTINCT economic_event,lifecycle_state FROM booking.nightly_revenue_evidence
       WHERE guest_booking_id=$1 AND corrects_evidence_id IS NOT NULL`,
      [scope.bookingId],
    );
    expect(reversals.rows).toEqual([
      { economic_event: "occupancy_adjustment", lifecycle_state: "canceled" },
    ]);
  });

  it("still refuses to record new nights without a booked offer", async () => {
    await expect(
      captureDirectNightlyRevenueEvidence(
        pool,
        { ...booking(), bookingMetadata: metadata() },
        { fingerprint: "test-capture", required: true },
      ),
    ).rejects.toThrow();
  });

  it("lets a host cancel a confirmed pricing-v2 booking and reverses its nights", async () => {
    const preview = await actions.preview(scope, { action: "cancel", reason: "Guest asked" });
    await expect(actions.apply(scope, preview.previewId, "host-cancel")).resolves.toEqual({
      bookingId: scope.bookingId,
      lifecycleStatus: "canceled",
    });
    expect(released).toHaveLength(1);
    expect((await nights()).every((n) => n.occupied === 0 && n.amount === "0.0000")).toBe(true);
  });
});
