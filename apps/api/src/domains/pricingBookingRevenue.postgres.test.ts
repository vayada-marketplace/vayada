import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { calculateReplacementFixedCharges } from "./replacementFixedCharges.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { stagePricingBookingRevenue } from "./pricingBookingRevenue.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteInventory.js", () => ({ reserveRevalidatedQuoteInventory: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
// Authority, pricing owners and PMS inventory are fixtures; lifecycle and revenue
// SQL, constraints and transaction rollback run against real PostgreSQL.
describe.skipIf(!url)("pricing initial revenue staging (PostgreSQL)", () => {
  it.each([
    "success",
    "wrong-quote",
    "wrong-currency",
    "wrong-property",
    "request",
    "expired",
    "authority-lost",
  ])("preserves exact revenue and rollback: %s", async (scenario) => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    vi.resetAllMocks();
    const propertyId = randomUUID(),
      bookingId = randomUUID();
    const f = pricingDraftFixture((q) => {
      Object.assign(q, {
        quoteId: randomUUID(),
        acceptanceMode: scenario === "request" ? "request" : "instant",
      });
      const second = { ...q.stay.rooms[0], selectionId: "two" };
      Object.assign(q.stay, { propertyId, rooms: [...q.stay.rooms, second] });
      const room = structuredClone(q.rooms[0]);
      Object.assign(room, { selectionId: "two" });
      Object.assign(room.nights[0], { roomMinor: "11000", totalMinor: "14000" });
      Object.assign(room.nights[1], { roomMinor: "19000", totalMinor: "22000" });
      Object.assign(q.rooms[0].nights[0], { roomMinor: "14001", totalMinor: "17001" });
      Object.assign(q.rooms[0].nights[1], { roomMinor: "15999", totalMinor: "18999" });
      Object.assign(q, { rooms: [...q.rooms, room] });
      Object.assign(q.evidence, {
        lines: [
          ...q.evidence.lines,
          { id: "r2", selectionId: "two", kind: "room", amountMinor: "30000" },
          { id: "m2", selectionId: "two", kind: "meal", amountMinor: "6000" },
        ],
        totalMinor: "72000",
        dueLaterMinor: "72000",
        requestKey: replacementStayKey(q.stay),
      });
    });
    f.current.scope.propertyId = propertyId;
    const quote = f.current.quote;
    const charges = {
      ...calculateReplacementFixedCharges(quote.stay, {
        version: "booking.fixed-charges.v1",
        currency: "EUR",
        charges: [],
      })!,
      sourceRevision: "charges:1",
    };
    Object.assign(quote.evidence.revisions, { charges: charges.sourceRevision });
    Object.assign(quote.evidence, { mandatoryChargeEvidenceId: charges.basisEvidenceId });
    Object.assign(f.current, { calculation: { charges } });
    const bundle = parsePmsInventoryReservationBundle(
      acceptanceFixture().inventory_reservation_bundle,
    )!;
    vi.mocked(lockPublicPricingAuthority).mockResolvedValue(f.current.scope);
    vi.mocked(reserveRevalidatedQuoteInventory).mockResolvedValue({
      quote,
      bundle,
      replayed: false,
    });
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      Object.assign(quote.evidence, {
        issuedAt: new Date(now.getTime() - 60000).toISOString(),
        expiresAt: new Date(now.getTime() + 600000).toISOString(),
      });
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic revenue')",
        [propertyId],
      );
      await db.query(
        `INSERT INTO booking.guest_bookings
          (id,property_id,public_reference,source_system,booking_channel,direct_booking_source,
          lifecycle_status,payment_status,expected_payment_method,check_in,check_out,adults,children,room_count,
          currency,total_amount,balance_amount,booking_metadata)
          VALUES($1,$2,$3,'booking','direct','booking_engine','draft','unpaid','pay_at_property',$4,$5,4,2,2,'EUR',720,720,$6)`,
        [
          bookingId,
          propertyId,
          `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`,
          quote.stay.checkIn,
          quote.stay.checkOut,
          {
            targetSource: "pricing_quote_draft",
            pricingQuoteId: quote.quoteId,
            acceptanceMode: quote.acceptanceMode,
            paymentMethod: quote.paymentMethod,
            pricingSelections: quote.stay.rooms,
            requestFingerprint: f.command.fingerprint,
          },
        ],
      );
      const client = db as unknown as PoolClient;
      const lifecycle = await stagePricingBookingLifecycle(
        client,
        "synthetic",
        f.current,
        bookingId,
      );
      if (scenario === "wrong-quote")
        await db.query(
          "UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,'{pricingQuoteId}',to_jsonb($2::text)) WHERE id=$1",
          [bookingId, randomUUID()],
        );
      if (scenario === "wrong-currency")
        await db.query("UPDATE booking.guest_bookings SET currency='USD' WHERE id=$1", [bookingId]);
      if (scenario === "wrong-property")
        f.current.scope = { ...f.current.scope, propertyId: randomUUID() };
      if (scenario === "expired")
        Object.assign(quote.evidence, { expiresAt: new Date(now.getTime() - 1).toISOString() });
      if (scenario === "authority-lost")
        vi.mocked(lockPublicPricingAuthority)
          .mockReset()
          .mockResolvedValueOnce(f.current.scope)
          .mockResolvedValue(null);
      const run = () => stagePricingBookingRevenue(client, "synthetic", f.current, lifecycle);
      if (scenario === "success") {
        await expect(run()).resolves.toEqual({ bookingId, roomNights: 4 });
        const evidence = (
          await db.query(
            "SELECT stay_date::text,recognized_on::text,line_position,gross_room_amount::text,currency,economic_event FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 ORDER BY line_position,stay_date",
            [bookingId],
          )
        ).rows;
        expect(evidence.map((r) => r.gross_room_amount)).toEqual([
          "140.0100",
          "159.9900",
          "110.0000",
          "190.0000",
        ]);
        expect(evidence.map((r) => r.line_position)).toEqual([1, 1, 2, 2]);
        expect(
          evidence.every(
            (r) =>
              r.stay_date === r.recognized_on &&
              r.currency === "EUR" &&
              r.economic_event === "room_night",
          ),
        ).toBe(true);
        await expect(run()).rejects.toThrow("unavailable");
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
              [bookingId],
            )
          ).rows[0].n,
        ).toBe(4);
      } else {
        await expect(run()).rejects.toThrow("unavailable");
        const n = (
          await db.query(
            "SELECT count(*)::int AS n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n;
        expect(n).toBe(["expired", "authority-lost"].includes(scenario) ? 4 : 0);
      }
      // Caller must roll back all earlier writes even after a late guard fails.
      await db.query("ROLLBACK");
      for (const table of [
        "nightly_revenue_evidence",
        "booking_status_events",
        "direct_booking_summary_read_model",
      ]) {
        expect(
          (
            await db.query(
              `SELECT count(*)::int AS n FROM booking.${table} WHERE guest_booking_id=$1`,
              [bookingId],
            )
          ).rows[0].n,
        ).toBe(0);
      }
      expect(
        (
          await db.query("SELECT count(*)::int AS n FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
  });
});
