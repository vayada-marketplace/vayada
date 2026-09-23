import { describe, expect, it } from "vitest";
import { id } from "./affiliatePublicationTestFixture.js";
import { parseAffiliateVisitDisclosure } from "./marketplaceAffiliateVisitScope.js";

const disclosure = (days: number, destination = id(30)) => ({
  contractVersion: "marketplace-published-affiliate-terms.v1",
  terms: {
    bookingDestinationId: destination,
    financePolicyVersionId: "policy-1",
    attributionWindowDays: days,
  },
});

describe("affiliate visit disclosure", () => {
  it("accepts only a native destination ID with a live-compliant window", () => {
    expect(parseAffiliateVisitDisclosure(JSON.stringify(disclosure(90)))).toEqual({
      destinationVersionId: id(30),
      attributionWindowDays: 90,
    });
    expect(parseAffiliateVisitDisclosure(disclosure(91))).toBeNull();
    expect(parseAffiliateVisitDisclosure(disclosure(14, "https://other.example"))).toBeNull();
    expect(
      parseAffiliateVisitDisclosure({ ...disclosure(14), contractVersion: "wrong" }),
    ).toBeNull();
  });
});
