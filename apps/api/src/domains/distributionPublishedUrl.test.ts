import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import { buildBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import { expect, it, vi } from "vitest";
import { createPgDistributionBookingPublicationProjection } from "./distributionBookingPublicationProjection.js";
import type { DistributionBookingPublicationPool } from "./distributionBookingPublicationProjection.js";
const profile = PUBLIC_BOOKABILITY_FIXTURES.find(({ caseId }) => caseId === "bookable")!.profile;
function harness(publicContent: unknown) {
  const query = vi.fn().mockResolvedValue({ rows: [{ publicContent }], rowCount: 1 });
  const release = vi.fn();
  const pool = {
    connect: async () => ({ query, release }),
    end: async () => {},
  } as unknown as DistributionBookingPublicationPool;
  return {
    query,
    release,
    repository: createPgDistributionBookingPublicationProjection({
      connectionString: "postgresql://unused",
      pool,
    }),
  };
}
it("reads a canonical guest URL only from the requested active immutable revision", async () => {
  const h = harness(content(profile));
  expect(await h.repository.getPublishedUrl(profile.hotel.propertyId, "revision")).toBe(
    new URL(profile.hotel.canonicalUrl).toString(),
  );
  expect(h.query.mock.calls[0]?.[1]).toEqual([profile.hotel.propertyId, "revision"]);
  expect(h.query.mock.calls[0]?.[0]).toContain("active.content_revision_id = $2::uuid");
  expect(h.release).toHaveBeenCalledOnce();
});
it("withholds malformed, foreign and unavailable published content", async () => {
  for (const data of [
    null,
    { profile },
    content({ ...profile, hotel: { ...profile.hotel, propertyId: "foreign-property" } }),
  ]) {
    expect(
      await harness(data).repository.getPublishedUrl(profile.hotel.propertyId, "revision"),
    ).toBeNull();
  }
  const h = harness(content(profile));
  h.query.mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await h.repository.getPublishedUrl(profile.hotel.propertyId, "old-revision")).toBeNull();
});
function content(value: typeof profile) {
  const result = buildBookingPublicContent({
    sourceManifestHash: `sha256:${"1".repeat(64)}`,
    readinessHash: `sha256:${"2".repeat(64)}`,
    profile: value,
    rooms: [
      {
        roomTypeId: "room-1",
        name: "Room",
        description: "A room.",
        category: null,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        beds: [{ type: "double", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: null,
        images: [{ url: "https://cdn.example/room.jpg" }],
        amenities: ["wifi"],
        rates: [
          {
            ratePlanId: "rate-1",
            currency: "EUR",
            baseNightlyAmount: "100.00",
            refundable: true,
            paymentTiming: "pay_at_property",
          },
        ],
      },
    ],
    calendar: {
      sourceRevision: "calendar-1",
      materializedRevision: "calendar-1",
      currentLocalDate: "2026-06-06",
      coverageFrom: "2026-06-06",
      coverageThrough: "2027-06-06",
      materializedThrough: "2027-06-06",
      expectedDayCount: 366,
      materializedDayCount: 366,
      gapCount: 0,
      roomTypeIds: ["room-1"],
      observedAt: value.generatedAt,
    },
    finance: {
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      onlinePayment: true,
      payAtProperty: true,
      readyPaymentMethods: ["card", "pay_at_property"],
    },
  });
  if (!result) throw new Error("Expected valid Booking public content fixture");
  return result.publicContent;
}
