import { expect, it } from "vitest";
import { buildApp } from "../app.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";
import { createTargetBookingWebCheckoutAdapter } from "./bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import type { Pool } from "pg";

it("serves explicit add-on metadata through the public no-store route", async () => {
  const body = { version: "public-pricing-addons.v1", addons: [] };
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: {
      ...unusedBookingWebCheckoutAdapter,
      getPricingAddons: async (slug) => {
        expect(slug).toBe("hotel");
        return body;
      },
    },
  });
  try {
    const reply = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel/pricing-addons",
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(body);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-robots-tag"]).toBe("noindex");
  } finally {
    await app.close();
  }
});
it("does not expose an unconfigured catalogue or underlying database errors", async () => {
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
  });
  try {
    expect(
      (await app.inject({ method: "GET", url: "/api/booking-web/hotels/hotel/pricing-addons" }))
        .statusCode,
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
    connectionString: "postgresql://unused",
    pool,
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
  });
  try {
    await expect(adapter.getPricingAddons!("hotel")).rejects.toMatchObject({
      statusCode: 503,
      message: "Pricing extras temporarily unavailable.",
    });
  } finally {
    await adapter.close?.();
  }
});
