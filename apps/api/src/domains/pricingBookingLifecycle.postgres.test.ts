import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteInventory.js", () => ({ reserveRevalidatedQuoteInventory: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
// Owner authority and inventory are mocked; booking/event/summary SQL and the
// PostgreSQL clock are real. This is lifecycle staging, not acceptance coverage.
describe.skipIf(!url)("PostgreSQL pricing booking lifecycle staging", () => {
  it.each(["instant", "request", "summary-conflict"] as const)(
    "stores or rolls back lifecycle (%s)",
    async (scenario) => {
      const mode = scenario === "instant" ? "instant" : "request";
      if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
        throw new Error("test database required");
      const propertyId = randomUUID(),
        bookingId = randomUUID();
      const f = pricingDraftFixture((quote) => {
        Object.assign(quote, { quoteId: randomUUID(), acceptanceMode: mode });
        Object.assign(quote.stay, { propertyId });
        Object.assign(quote.evidence, { requestKey: replacementStayKey(quote.stay) });
      });
      f.current.scope.propertyId = propertyId;
      const quote = f.current.quote;
      const bundle = acceptanceFixture().inventory_reservation_bundle;
      vi.mocked(lockPublicPricingAuthority).mockResolvedValue(f.current.scope);
      vi.mocked(reserveRevalidatedQuoteInventory).mockReset();
      vi.mocked(reserveRevalidatedQuoteInventory).mockResolvedValue({
        quote,
        bundle,
      } as unknown as Awaited<ReturnType<typeof reserveRevalidatedQuoteInventory>>);
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
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic lifecycle')",
          [propertyId],
        );
        await db.query(
          `INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,booking_channel,direct_booking_source,
         lifecycle_status,payment_status,expected_payment_method,check_in,check_out,
         adults,children,room_count,currency,total_amount,balance_amount,booking_metadata)
        VALUES($1,$2,$3,'booking','direct','booking_engine','draft','unpaid','pay_at_property',$4,$5,2,1,1,'EUR',360,360,$6)`,
          [
            bookingId,
            propertyId,
            `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`,
            quote.stay.checkIn,
            quote.stay.checkOut,
            {
              targetSource: "pricing_quote_draft",
              pricingQuoteId: quote.quoteId,
              acceptanceMode: mode,
              paymentMethod: quote.paymentMethod,
              pricingSelections: quote.stay.rooms,
              requestFingerprint: f.command.fingerprint,
            },
          ],
        );
        if (scenario === "summary-conflict") {
          await db.query(
            `INSERT INTO booking.direct_booking_summary_read_model
            (guest_booking_id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out)
            SELECT id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out
            FROM booking.guest_bookings WHERE id=$1`,
            [bookingId],
          );
          await expect(
            stagePricingBookingLifecycle(
              db as unknown as PoolClient,
              "synthetic",
              f.current,
              bookingId,
            ),
          ).rejects.toMatchObject({ code: "23505" });
        } else {
          const result = await stagePricingBookingLifecycle(
            db as unknown as PoolClient,
            "synthetic",
            f.current,
            bookingId,
          );
          const expectedStatus = mode === "instant" ? "confirmed" : "pending_payment";
          expect(result.lifecycleStatus).toBe(expectedStatus);
          expect(result.inventoryReservation).toEqual(bundle);
          if (mode === "request")
            expect(Date.parse(result.hostResponseDeadlineAt!) - Date.parse(result.occurredAt)).toBe(
              86400000,
            );
          else expect(result.hostResponseDeadlineAt).toBeNull();
          const booking = (
            await db.query(
              "SELECT lifecycle_status,payment_status,balance_amount::text,booking_metadata FROM booking.guest_bookings WHERE id=$1",
              [bookingId],
            )
          ).rows[0];
          expect(booking).toMatchObject({
            lifecycle_status: expectedStatus,
            payment_status: "unpaid",
            balance_amount: "360.00",
            booking_metadata: { inventoryReservation: bundle },
          });
          if (mode === "request")
            expect(booking.booking_metadata.hostResponseDeadlineAt).toBe(
              result.hostResponseDeadlineAt,
            );
          else expect(booking.booking_metadata).not.toHaveProperty("hostResponseDeadlineAt");
          const events = (
            await db.query(
              "SELECT event_type,from_status,to_status,actor_type,public_visible,event_payload,occurred_at FROM booking.booking_status_events WHERE guest_booking_id=$1",
              [bookingId],
            )
          ).rows;
          expect(events).toEqual([
            {
              event_type: "guest_booking.created",
              from_status: "draft",
              to_status: expectedStatus,
              actor_type: "guest",
              public_visible: true,
              event_payload: {
                pricingQuoteId: quote.quoteId,
                requestFingerprint: f.command.fingerprint,
              },
              occurred_at: new Date(result.occurredAt),
            },
          ]);
          const summary = (
            await db.query(
              "SELECT lifecycle_status,payment_status,guest_counts,room_summary,amount_summary,public_policy,projected_at FROM booking.direct_booking_summary_read_model WHERE guest_booking_id=$1",
              [bookingId],
            )
          ).rows;
          expect(summary).toEqual([
            {
              lifecycle_status: expectedStatus,
              payment_status: "unpaid",
              guest_counts: { adults: 2, children: 1 },
              room_summary: { roomCount: 1 },
              amount_summary: { totalAmount: "360.00", balanceAmount: "360.00", currency: "EUR" },
              public_policy: { acceptanceMode: mode },
              projected_at: new Date(result.occurredAt),
            },
          ]);
          await expect(
            stagePricingBookingLifecycle(
              db as unknown as PoolClient,
              "synthetic",
              f.current,
              bookingId,
            ),
          ).rejects.toThrow("unavailable");
          expect(reserveRevalidatedQuoteInventory).toHaveBeenCalledTimes(1);
          expect(
            (
              await db.query("SELECT booking_metadata FROM booking.guest_bookings WHERE id=$1", [
                bookingId,
              ])
            ).rows[0].booking_metadata,
          ).toEqual(booking.booking_metadata);
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM booking.booking_status_events WHERE guest_booking_id=$1",
                [bookingId],
              )
            ).rows[0].n,
          ).toBe(1);
        }
        await db.query("ROLLBACK");
        for (const [table, column] of [
          ["guest_bookings", "id"],
          ["booking_status_events", "guest_booking_id"],
          ["direct_booking_summary_read_model", "guest_booking_id"],
        ])
          expect(
            (
              await db.query(`SELECT count(*)::int AS n FROM booking.${table} WHERE ${column}=$1`, [
                bookingId,
              ])
            ).rows[0].n,
          ).toBe(0);
      } finally {
        await db.query("ROLLBACK");
        await db.end();
      }
    },
  );
});
