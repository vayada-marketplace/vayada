import { expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../app.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";
import {
  AGENCY_STAY_PRICES_PATH,
  createTargetBookingWebCheckoutAdapter,
} from "./bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";

const SEARCH = "checkIn=2026-11-06&checkOut=2026-11-08&adults=2";
const ROUTE = `/api/booking-web/agency-pages/the-travel-ubud/stay-prices?${SEARCH}`;

it("serves an agency page's stay prices through the public no-store route (VAY-2458)", async () => {
  const body = { version: "agency-stay-prices.v1", stays: [] };
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: {
      ...unusedBookingWebCheckoutAdapter,
      getAgencyStayPrices: async (slug, query) => {
        expect(slug).toBe("the-travel-ubud");
        expect(query).toEqual({ checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2" });
        return body;
      },
    },
  });
  try {
    const reply = await app.inject({ method: "GET", url: ROUTE });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(body);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-robots-tag"]).toBe("noindex");
    // Guests' browsers call it directly: its access line, with their address, isn't logged.
    expect(AGENCY_STAY_PRICES_PATH.test(ROUTE.split("?")[0]!)).toBe(true);
    expect(AGENCY_STAY_PRICES_PATH.test("/api/booking-web/agency-pages/a/b/stay-prices")).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});

it("admits 30 searches a minute per guest address", async () => {
  let reads = 0;
  const app = buildApp({
    logger: false,
    trustProxy: ["10.0.0.1"],
    bookingWebPublicNow: () => new Date("2026-11-02T10:00:15.000Z"),
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: {
      ...unusedBookingWebCheckoutAdapter,
      getAgencyStayPrices: async () => {
        reads++;
        return { stays: [] };
      },
    },
  });
  const search = (forwardedFor: string) =>
    app.inject({
      method: "GET",
      url: ROUTE,
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": forwardedFor },
    });
  try {
    for (let attempt = 0; attempt < 30; attempt++)
      expect((await search("198.51.100.7")).statusCode).toBe(200);
    const limited = await search("198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("45");
    expect(limited.json()).toMatchObject({
      message: "Too many searches. Please try again in a minute.",
    });
    // Another guest has a bucket of their own.
    expect((await search("203.0.113.9")).statusCode).toBe(200);
    expect(reads).toBe(31);
  } finally {
    await app.close();
  }
});

it("is missing without the read, refuses an invalid search and hides database errors", async () => {
  const app = buildApp({
    logger: false,
    publicHotelProfileRepository: { findProfileBySlug: async () => null },
    bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
  });
  try {
    expect((await app.inject({ method: "GET", url: ROUTE })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
  const pool = {
    connect: async () => {
      throw new Error("private database detail");
    },
    query: async () => {
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
      adapter.getAgencyStayPrices!("the-travel-ubud", {
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        adults: "2",
        rooms: "1-0",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      adapter.getAgencyStayPrices!("the-travel-ubud", {
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        adults: "2",
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: "Stay prices temporarily unavailable." });
    // An address that can't be an agency page's is simply not found.
    await expect(
      adapter.getAgencyStayPrices!("Not A Page", {
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        adults: "2",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    await adapter.close?.();
  }
});
