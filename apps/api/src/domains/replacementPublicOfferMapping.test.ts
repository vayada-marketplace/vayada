import { expect, it } from "vitest";
import { publicPricingOfferKey } from "./publicPricingRoomStay.js";
import {
  publicOfferCancellations,
  publicOfferPaymentSchedules,
} from "./replacementPublicOfferMapping.js";

// VAY-2320: a group books rooms paid the same way, so the catalog says how each rate is paid.
it("names how each offer is paid, keyed so equal deposits match", () => {
  const room = "11111111-1111-4111-8111-111111111111";
  const deposit = (basisPoints: number, acceptedMethods: string[]) => ({
    kind: "deposit",
    basisPoints,
    balanceDaysBeforeArrival: 7,
    acceptedMethods,
  });
  const owner = {
    scope: { propertyId: "property" },
    pmsSourceRevision: "pms-1",
    publication: {
      rooms: [
        {
          roomTypeId: room,
          offers: ["flex", "deposit", "same", "other", "stale"].map((id) => ({
            id,
            termsRevision: `${id}-1`,
          })),
        },
      ],
    },
    terms: [
      { offerId: "flex", payment: { kind: "full", acceptedMethods: ["pay_at_property"] } },
      { offerId: "deposit", payment: deposit(3000, ["card"]) },
      { offerId: "same", payment: deposit(3000, ["card"]) },
      { offerId: "other", payment: deposit(5000, ["card"]) },
      // Terms of another revision than the published offer's are not this offer's terms.
      { offerId: "stale", revision: "stale-0", payment: { kind: "full" } },
    ].map((t) => ({ roomTypeId: room, revision: `${t.offerId}-1`, ...t })),
  };
  const schedules = publicOfferPaymentSchedules(owner as never);
  const of = (offerId: string) => schedules.get(publicPricingOfferKey("pms-1", room, offerId));
  expect(of("flex")).toEqual({ kind: "full" });
  expect(of("deposit")).toEqual({ kind: "deposit", percent: 30, key: "deposit:3000:7:card" });
  expect(of("same")).toEqual(of("deposit"));
  expect(of("other")).toMatchObject({ kind: "deposit", percent: 50 });
  expect(of("other")).not.toEqual(of("deposit"));
  expect(of("stale")).toBeUndefined();
});

// VAY-2406: a partial refund says its last refund day, so the booking page can tell when refunds are
// over for a stay.
it("adds a partial refund's last refund day to its cancellation", () => {
  const room = "11111111-1111-4111-8111-111111111111";
  const flexible = (extra: Record<string, unknown>) => ({
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 14,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      ...extra,
    },
  });
  const partial = (tiers: { minDaysBeforeCheckIn: number; refundPercent: number }[]) =>
    flexible({ flexibleCancellationType: "partial_refund", partialRefundTiers: tiers });
  const cancellations = {
    steps: partial([
      { minDaysBeforeCheckIn: 30, refundPercent: 100 },
      { minDaysBeforeCheckIn: 14, refundPercent: 50 },
      { minDaysBeforeCheckIn: 3, refundPercent: 0 },
    ]),
    free: flexible({}),
    none: { kind: "non_refundable" },
  };
  const owner = {
    scope: { propertyId: "property" },
    pmsSourceRevision: "pms-1",
    publication: {
      rooms: [
        {
          roomTypeId: room,
          offers: Object.keys(cancellations).map((id) => ({ id, termsRevision: `${id}-1` })),
        },
      ],
    },
    terms: Object.entries(cancellations).map(([offerId, cancellation]) => ({
      roomTypeId: room,
      offerId,
      revision: `${offerId}-1`,
      cancellation,
    })),
  };
  const all = publicOfferCancellations(owner as never);
  const of = (offerId: string) => all.get(publicPricingOfferKey("pms-1", room, offerId));
  // The 0% step after the last refund adds nothing: refunds end with the 50% step.
  expect(of("steps")).toEqual({ kind: "partial_refund", days: 14 });
  expect(of("free")).toEqual({ kind: "free_until_days_before_arrival", days: 14 });
  expect(of("none")).toEqual({ kind: "non_refundable" });
});
