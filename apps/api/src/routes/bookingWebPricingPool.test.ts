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

describe("public pricing pool", () => {
  it("issues offers and quotes on the checkout pool", async () => {
    let checkoutCalls = 0;
    const checkoutPool = {
      async connect() {
        checkoutCalls++;
        throw new Error("checkout database unavailable");
      },
    } as unknown as pg.Pool;
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgresql://unused",
      pool: checkoutPool,
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
    expect(checkoutCalls).toBe(2);
  });
});
