import { expect, it } from "vitest";
import { publicPricingOfferKey } from "./publicPricingRoomStay.js";
import { publicOfferPaymentSchedules } from "./replacementPublicOfferMapping.js";

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
