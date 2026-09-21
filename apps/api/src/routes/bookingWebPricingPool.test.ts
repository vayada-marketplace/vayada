import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import { createTargetBookingWebCheckoutAdapter } from "./bookingWebPublic.js";

const quoteRequest = {
  version: "public-booking-quote-request.v1",
  selection: {
    version: "public-pricing-selection.v1",
    checkIn: "2026-10-01",
    checkOut: "2026-10-02",
    currency: "EUR",
    rooms: [
      {
        selectionId: "one",
        publicOfferKey: "offer",
        guests: { adults: 1, childAgesAtCheckIn: [] },
      },
    ],
    addons: [],
    promoCode: null,
  },
  paymentMethod: "pay_at_property",
} as const;

describe("public pricing pool isolation", () => {
  it.each([false, true])(
    "never falls back to checkout pool (configured: %s)",
    async (configured) => {
      let checkoutCalls = 0;
      let pricingCalls = 0;
      const checkoutPool = {
        async connect() {
          checkoutCalls++;
          throw new Error("checkout credential used for pricing");
        },
        async query() {
          checkoutCalls++;
          throw new Error("checkout credential used for pricing");
        },
      } as unknown as pg.Pool;
      const pricingPool = configured
        ? ({
            async connect() {
              pricingCalls++;
              throw new Error("pricing database unavailable");
            },
          } as unknown as pg.Pool)
        : null;
      const adapter = createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: "postgresql://unused",
        pool: checkoutPool,
        pricingPool,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      });

      await expect(adapter.getPricingOffers!("hotel")).rejects.toMatchObject({ statusCode: 503 });
      await expect(
        adapter.quoteBooking("hotel", quoteRequest, {
          operation: "quote",
          requestId: "request",
          correlationId: "request",
          idempotencyKey: "request",
          fingerprint: "request",
          occurredAt: new Date("2026-09-21T00:00:00Z"),
        }),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(checkoutCalls).toBe(0);
      expect(pricingCalls).toBe(configured ? 2 : 0);
    },
  );
});
