import { describe, expect, it } from "vitest";
import {
  AFFILIATE_TRACKING_PURPOSES,
  assessAffiliateDestinationTracking,
  parseAffiliateBookingDestinationConfiguration as parse,
  type AffiliateDestinationTrackingEvidence as Evidence,
} from "./affiliateBookingDestination.js";
const assess = (
  destination: Parameters<typeof assessAffiliateDestinationTracking>[0],
  evidence: Evidence[],
) => assessAffiliateDestinationTracking(destination, evidence, new Date("2026-09-10T01:00:00Z"));
const config = {
  displayName: " Hotel bookings ",
  bookingUrl: "https://booking.example.com/stay?hotel=42",
};
const destination = {
  destinationVersionId: "destination-v1",
  propertyId: "hotel-1",
  enabled: true,
};
const evidence = (): Evidence[] =>
  AFFILIATE_TRACKING_PURPOSES.map((purpose, i) => ({
    ...destination,
    purpose,
    connectionId: i < 2 ? "booking-engine" : "external-pms",
    connectionStatus: "active",
    support: "supported",
    validation: "validated",
    evidenceReference: `proof-${purpose}`,
    validatedAt: "2026-09-10T00:00:00Z",
    health: "healthy",
  }));
describe("affiliate booking destination", () => {
  it("normalizes a named HTTPS page while preserving provider property parameters", () => {
    expect(parse(config)).toEqual({ ...config, displayName: "Hotel bookings" });
    expect(Object.isFrozen(parse(config))).toBe(true);
  });
  it("rejects unsafe or ambiguous URLs and server-owned configuration fields", () => {
    for (const bookingUrl of [
      "http://example.com",
      "https:///booking.example.com",
      "https:////booking.example.com",
      "https://@booking.example.com",
      "javascript:alert(1)",
      "/book",
      "https://u:p@example.com",
      "https://example.com/#x",
      "https://example.com/ space",
      "https://example.com/\u0000",
      "https://example.com/\\path",
      "https://" + "a".repeat(2048),
    ])
      expect(parse({ ...config, bookingUrl })).toBeNull();
    for (const override of [
      { verified: true },
      { propertyId: "other" },
      { displayName: " " },
      { displayName: "x".repeat(121) },
    ])
      expect(parse({ ...config, ...override })).toBeNull();
    const getter = { ...config };
    Object.defineProperty(getter, "bookingUrl", {
      get() {
        throw new Error("must not execute");
      },
    });
    expect(parse(getter)).toBeNull();
  });
  it("requires all independent purposes and allows different booking/PMS connections", () => {
    expect(Object.isFrozen(AFFILIATE_TRACKING_PURPOSES)).toBe(true);
    expect(assess(destination, [])).toEqual({
      status: "pending",
      missing: [...AFFILIATE_TRACKING_PURPOSES],
    });
    expect(assess(destination, evidence())).toEqual({ status: "verified", missing: [] });
    expect(assess(destination, [...evidence(), evidence()[0]!])).toEqual({
      status: "pending",
      missing: ["referral_round_trip"],
    });
    expect(assess(destination, evidence().slice(0, 3))).toEqual({
      status: "pending",
      missing: ["accommodation_revenue"],
    });
  });
  it("cannot inherit proof from another hotel or destination version", () => {
    for (const override of [
      { propertyId: "other" },
      { destinationVersionId: "destination-v2" },
      { enabled: false },
      { propertyId: "" },
    ])
      expect(assess({ ...destination, ...override }, evidence()).status).toBe("pending");
  });
  it("rejects documented, stale, revoked or incomplete evidence", () => {
    for (const override of [
      { support: "unknown" },
      { validation: "documented" },
      { validation: "not_validated" },
      { health: "stale" },
      { health: "unavailable" },
      { connectionStatus: "revoked" },
      { connectionId: "" },
      { evidenceReference: null },
      { validatedAt: null },
      { validatedAt: "bad-date" },
      { validatedAt: "2027-01-01T00:00:00Z" },
    ] as Partial<Evidence>[]) {
      const items = evidence();
      items[0] = { ...items[0]!, ...override };
      expect(assess(destination, items)).toEqual({
        status: "pending",
        missing: ["referral_round_trip"],
      });
    }
  });
});
