import { describe, expect, it } from "vitest";

import {
  addDays,
  bookingBaseUrlFor,
  firstDayOfUtcMonth,
  normalizeTimezone,
  occupancyForLegacyRoom,
} from "./bookingPublicBookabilityBackfill.js";

describe("booking public bookability backfill helpers", () => {
  it("normalizes the pilot date and URL fields used by the target constraints", () => {
    expect(firstDayOfUtcMonth(new Date("2026-06-20T14:00:00Z"))).toBe("2026-06-01");
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(normalizeTimezone("UTC")).toBe("Etc/UTC");
    expect(bookingBaseUrlFor("srijourneys", "https://next-booking.vayada.com")).toBe(
      "https://srijourneys.next-booking.vayada.com",
    );
    expect(occupancyForLegacyRoom({ maxOccupancy: 2, maxChildren: null })).toEqual({
      maxAdults: 2,
      maxOccupancy: 2,
    });
  });
});
