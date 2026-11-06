import { describe, expect, it } from "vitest";

import { buildBookingPreviewUrl } from "./bookingPreviewUrl";

describe("buildBookingPreviewUrl", () => {
  it("keeps local preview on the active portless fallback port", () => {
    expect(
      buildBookingPreviewUrl({
        slug: "hotel-alpenrose",
        location: {
          protocol: "https:",
          hostname: "admin.booking.localhost",
          port: "1355",
        },
      }),
    ).toBe("https://hotel-alpenrose.booking.localhost:1355");
  });

  it("honors an explicit deployment template", () => {
    expect(
      buildBookingPreviewUrl({
        slug: "hotel-alpenrose",
        template: "https://preview.example/{slug}/booking",
      }),
    ).toBe("https://preview.example/hotel-alpenrose/booking");
  });

  it("uses the documented Booking Web port for plain localhost development", () => {
    expect(
      buildBookingPreviewUrl({
        slug: "hotel-alpenrose",
        location: { protocol: "http:", hostname: "localhost", port: "3003" },
      }),
    ).toBe("http://hotel-alpenrose.localhost:3002");
  });

  // VAY-2483: *.booking.vayada.com is the old system, which knows none of the new system's pages.
  it("falls back to the new system's booking host, never the old one", () => {
    expect(
      buildBookingPreviewUrl({
        slug: "thetravelubud",
        location: { protocol: "https:", hostname: "next-booking-admin.vayada.com", port: "" },
      }),
    ).toBe("https://thetravelubud.next-booking.vayada.com");
    expect(buildBookingPreviewUrl({ slug: "hotel-alpenrose", template: "" })).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com",
    );
  });

  it("rejects non-canonical identifiers instead of opening a broken host", () => {
    expect(buildBookingPreviewUrl({ slug: "prop_123" })).toBeNull();
  });
});
