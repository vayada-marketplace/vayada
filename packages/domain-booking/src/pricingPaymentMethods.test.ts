import { describe, expect, it } from "vitest";
import { parseBookingPricingOfferTerms } from "./replacementPricingBrowser.js";
const terms = {
  roomTypeId: "11111111-1111-4111-8111-111111111111",
  offerId: "flex",
  revision: "22222222-2222-4222-8222-222222222222",
  cancellation: { kind: "non_refundable" },
  payment: { kind: "full" },
};
describe("explicit rate payment methods", () => {
  it("preserves historical absence and stores explicit methods without aliasing input", () => {
    expect(parseBookingPricingOfferTerms(terms)?.payment).toEqual({ kind: "full" });
    const acceptedMethods = ["card", "pay_at_property"];
    const parsed = parseBookingPricingOfferTerms({
      ...terms,
      payment: { kind: "full", acceptedMethods },
    });
    acceptedMethods.pop();
    expect(parsed?.payment.acceptedMethods).toEqual(["card", "pay_at_property"]);
    expect(
      parseBookingPricingOfferTerms({
        ...terms,
        payment: {
          kind: "deposit",
          basisPoints: 3000,
          balanceDaysBeforeArrival: 7,
          acceptedMethods: ["card"],
        },
      }),
    ).not.toBeNull();
  });
  it("rejects ambiguous, unsupported and malformed permissions", () => {
    for (const acceptedMethods of [
      undefined,
      null,
      [],
      ["card", "card"],
      ["cash"],
      "card",
      ["card", ,],
      ["card", "pay_at_property", "cash"],
    ])
      expect(
        parseBookingPricingOfferTerms({ ...terms, payment: { kind: "full", acceptedMethods } }),
      ).toBeNull();
    expect(
      parseBookingPricingOfferTerms({
        ...terms,
        payment: { kind: "full", acceptedMethods: ["card"], unknown: true },
      }),
    ).toBeNull();
  });
});
