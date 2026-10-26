import { expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../app.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";
import { createTargetBookingWebCheckoutAdapter } from "./bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";

const STAY = "checkIn=2026-11-06&checkOut=2026-11-08&adults=2";

it("serves the room cards' stay prices through the public no-store route", async () => {
  const body = { version: "public-pricing-stay-prices.v1", rooms: [] };
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: {
      ...unusedBookingWebCheckoutAdapter,
      getPricingStayPrices: async (slug, query) => {
        expect(slug).toBe("hotel");
        expect(query).toEqual({ checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2" });
        return body;
      },
    },
  });
  try {
    const reply = await app.inject({
      method: "GET",
      url: `/api/booking-web/hotels/hotel/pricing-offers/stay-prices?${STAY}`,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(body);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-robots-tag"]).toBe("noindex");
  } finally {
    await app.close();
  }
});

it("is missing without the read, refuses an invalid stay and hides database errors", async () => {
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
  });
  try {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/booking-web/hotels/hotel/pricing-offers/stay-prices?${STAY}`,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
  const pool = {
    connect: async () => {
      throw new Error("private database detail");
    },
  } as unknown as Pool;
  const adapter = createTargetBookingWebCheckoutAdapter({
    externalChanges: externalBookingChanges,
    connectionString: "postgresql://unused",
    pool,
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
  });
  try {
    await expect(
      adapter.getPricingStayPrices!("hotel", {
        checkIn: "2026-11-08",
        checkOut: "2026-11-06",
        adults: "2",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      adapter.getPricingStayPrices!("hotel", {
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        adults: "2",
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: "Stay prices temporarily unavailable." });
  } finally {
    await adapter.close?.();
  }
});
