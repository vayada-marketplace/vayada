import { describe, expect, it } from "vitest";
import { parseMarketplaceAffiliateOfferTerms } from "./affiliateOfferTerms.js";

const draft = {
  bookingDestinationId: "destination-7",
  financePolicyVersionId: "finance-policy-version-2",
  attributionWindowDays: 14,
};

describe("affiliate offer terms draft validation", () => {
  it("preserves explicit values without mutating or aliasing the request", () => {
    const input = { ...draft };
    const result = parseMarketplaceAffiliateOfferTerms(input);
    expect(result).toEqual({ ok: true, terms: draft });
    input.attributionWindowDays = 7;
    expect(result.ok && result.terms.attributionWindowDays).toBe(14);
  });

  it.each([undefined, null, [], "terms", 1])("rejects non-object input %s", (input) => {
    expect(parseMarketplaceAffiliateOfferTerms(input)).toMatchObject({ ok: false, field: "input" });
  });

  it.each([undefined, null, "14", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects absent or invalid attribution window %s instead of defaulting",
    (attributionWindowDays) => {
      expect(
        parseMarketplaceAffiliateOfferTerms({ ...draft, attributionWindowDays }),
      ).toMatchObject({
        ok: false,
        field: "attributionWindowDays",
      });
    },
  );

  it.each(["bookingDestinationId", "financePolicyVersionId"] as const)(
    "requires a bounded internal reference for %s",
    (field) => {
      for (const value of [
        undefined,
        null,
        "",
        " ",
        " id ",
        7,
        "https://hotel.test",
        "x".repeat(257),
      ]) {
        expect(parseMarketplaceAffiliateOfferTerms({ ...draft, [field]: value })).toMatchObject({
          ok: false,
          field,
        });
      }
    },
  );

  it.each([
    { commissionPercent: 10 },
    { participation: "open" },
    { propertyId: "another-property" },
    { rules: { earningEligibility: "click" } },
  ])("rejects extra policy or scope fields: %j", (extra) => {
    expect(parseMarketplaceAffiliateOfferTerms({ ...draft, ...extra })).toMatchObject({
      ok: false,
      field: "input",
    });
  });
});
