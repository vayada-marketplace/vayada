import { describe, expect, it } from "vitest";
import { airbnbInquiryEvidence } from "./airbnbInquiryEvidence.js";
const property = "22222222-2222-4222-8222-222222222222";
const event = "11111111-1111-4111-8111-111111111111";
const details = {
  property_id: property,
  listing_id: "listing",
  checkin_date: "2026-12-30",
  nights: 3,
  currency: "EUR",
  number_of_adults: 2,
  number_of_children: 0,
};
const input = {
  inquiry: true,
  providerChannel: "airbnb",
  providerPropertyId: property,
  threadId: "thread",
  eventId: event,
  bookingDetails: details,
};
describe("retained Airbnb inquiry evidence", () => {
  it("keeps the explicit event ID and verified stay without retaining guest PII", () => {
    const result = airbnbInquiryEvidence({
      ...input,
      bookingDetails: { ...details, guest_name: "Private Guest" },
    });
    expect(result).toMatchObject({
      eventId: event,
      arrivalDate: "2026-12-30",
      departureDate: "2027-01-02",
      adults: 2,
      children: 0,
      listingId: "listing",
    });
    expect(JSON.stringify(result)).not.toContain("Private Guest");
    expect(result?.contextDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not promote a generic live-feed notice to an actionable inquiry", () => {
    expect(airbnbInquiryEvidence({ ...input, inquiry: false })).toBeNull();
    expect(airbnbInquiryEvidence({ ...input, providerChannel: "booking.com" })).toBeNull();
  });
  it.each(["not-a-live-feed-uuid", undefined, ""])(
    "rejects absent/invalid explicit identity %s",
    (eventId) => {
      expect(airbnbInquiryEvidence({ ...input, eventId })).toBeNull();
    },
  );
  it.each(["listing_id", "currency", "number_of_adults", "number_of_children", "nights"])(
    "does not invent missing %s",
    (key) => {
      const partial: Record<string, unknown> = { ...details };
      delete partial[key];
      expect(airbnbInquiryEvidence({ ...input, bookingDetails: partial })).toBeNull();
    },
  );
  it("rejects conflicting property, stay and guest-count aliases", () => {
    for (const overrides of [
      { property_id: event },
      { checkout_date: "2027-01-03" },
      { adults: 4 },
      { children: 1 },
      { checkin_date: "2026-02-30" },
    ])
      expect(
        airbnbInquiryEvidence({ ...input, bookingDetails: { ...details, ...overrides } }),
      ).toBeNull();
  });
  it("rejects an unsupported stay even when explicit checkout matches", () => {
    const departure = new Date(`${details.checkin_date}T00:00:00Z`);
    departure.setUTCDate(departure.getUTCDate() + 5000);
    expect(
      airbnbInquiryEvidence({
        ...input,
        bookingDetails: {
          ...details,
          nights: 5000,
          checkout_date: departure.toISOString().slice(0, 10),
        },
      }),
    ).toBeNull();
    expect(
      airbnbInquiryEvidence({ ...input, bookingDetails: { ...details, nights: 3650 } }),
    ).not.toBeNull();
  });
  it("does not turn a synthetic non-UUID property ID into provider decision evidence", () => {
    expect(
      airbnbInquiryEvidence({
        ...input,
        providerPropertyId: "chx-vay-1372",
        bookingDetails: { ...details, property_id: "chx-vay-1372" },
      }),
    ).toBeNull();
  });
  it("retains every provider context change in the review digest", () => {
    expect(airbnbInquiryEvidence(input)?.contextDigest).not.toBe(
      airbnbInquiryEvidence({ ...input, bookingDetails: { ...details, number_of_adults: 3 } })
        ?.contextDigest,
    );
  });
});
