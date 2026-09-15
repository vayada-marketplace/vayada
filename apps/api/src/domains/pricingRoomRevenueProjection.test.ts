import { describe, expect, it } from "vitest";
import {
  parseStoredPricingQuote,
  replacementStayKey,
  type StoredPricingQuote,
} from "@vayada/domain-booking";
import { historicalQuoteFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { calculateReplacementFixedCharges } from "./replacementFixedCharges.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
function fixture(currency = "EUR") {
  const quote: Mutable<StoredPricingQuote> = historicalQuoteFixture();
  quote.stay.currency = quote.evidence.currency = currency;
  quote.evidence.requestKey = replacementStayKey(quote.stay);
  const calculated = calculateReplacementFixedCharges(quote.stay, {
    version: "booking.fixed-charges.v1",
    currency,
    charges: [],
  })!;
  const charges = { ...calculated, sourceRevision: "charges:1", policyRevision: "1" };
  quote.evidence.revisions.charges = charges.sourceRevision;
  quote.evidence.mandatoryChargeEvidenceId = charges.basisEvidenceId;
  return { quote, charges };
}

describe("pricing room revenue projection", () => {
  it("preserves unequal service nights and excludes breakfast", () => {
    const { quote, charges } = fixture();
    Object.assign(quote.rooms[0].nights[0], { roomMinor: "14001", totalMinor: "17001" });
    Object.assign(quote.rooms[0].nights[1], { roomMinor: "15999", totalMinor: "18999" });
    expect(pricingRoomRevenueProjection(quote, charges)?.nights).toEqual([
      {
        stayDate: "2026-10-01",
        grossRoomAmount: "140.01",
        roomTypeId: quote.stay.rooms[0].roomTypeId,
        roomPositions: [1],
      },
      {
        stayDate: "2026-10-02",
        grossRoomAmount: "159.99",
        roomTypeId: quote.stay.rooms[0].roomTypeId,
        roomPositions: [1],
      },
    ]);
  });
  it.each([
    ["JPY", "15000"],
    ["KWD", "15.000"],
  ])("preserves %s currency precision", (currency, expected) => {
    const { quote, charges } = fixture(currency);
    expect(pricingRoomRevenueProjection(quote, charges)?.nights[0].grossRoomAmount).toBe(expected);
  });
  it.each([false, true])(
    "maps physical selections with reordered evidence (same type: %s)",
    (sameType) => {
      const { quote } = fixture();
      const second = {
        ...quote.stay.rooms[0],
        selectionId: "two",
        roomTypeId: sameType
          ? quote.stay.rooms[0].roomTypeId
          : "00000000-0000-4000-8000-000000000003",
      };
      quote.stay.rooms.push(second);
      quote.rooms.unshift({ ...structuredClone(quote.rooms[0]), selectionId: "two" });
      if (!sameType)
        quote.evidence.terms.push({ ...quote.evidence.terms[0], roomTypeId: second.roomTypeId });
      quote.evidence.lines.push(
        { id: "r2", selectionId: "two", kind: "room", amountMinor: "30000" },
        { id: "m2", selectionId: "two", kind: "meal", amountMinor: "6000" },
      );
      Object.assign(quote.evidence, {
        totalMinor: "72000",
        dueNowMinor: "21600",
        dueLaterMinor: "50400",
        requestKey: replacementStayKey(quote.stay),
      });
      const charges = {
        ...calculateReplacementFixedCharges(quote.stay, {
          version: "booking.fixed-charges.v1",
          currency: "EUR",
          charges: [],
        })!,
        sourceRevision: "charges:1",
      };
      quote.evidence.mandatoryChargeEvidenceId = charges.basisEvidenceId;
      const nights = pricingRoomRevenueProjection(quote, charges)?.nights;
      expect(nights).toHaveLength(4);
      expect(nights?.map((n) => [n.roomTypeId, n.roomPositions])).toEqual([
        [quote.stay.rooms[0].roomTypeId, [1]],
        [quote.stay.rooms[0].roomTypeId, [1]],
        [second.roomTypeId, [2]],
        [second.roomTypeId, [2]],
      ]);
    },
  );
  it("does not count additional charges or add-ons as room revenue", () => {
    const { quote, charges } = fixture();
    quote.evidence.lines.push(
      { id: "fee", selectionId: null, kind: "charge", amountMinor: "500" },
      { id: "extra", selectionId: null, kind: "addon", amountMinor: "1000" },
    );
    Object.assign(quote.evidence, { totalMinor: "37500", dueLaterMinor: "26700" });
    charges.additionalChargeMinor = "500";
    const chargeEvidence = {
      ...charges,
      charges: [
        {
          id: "fee",
          included: false,
          amountMinor: "500",
          basisEvidenceId: charges.basisEvidenceId,
        },
      ],
    };
    expect(
      pricingRoomRevenueProjection(quote, chargeEvidence)?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["150.00", "150.00"]);
  });
  it("rejects a valid discounted quote without nightly discount allocation", () => {
    const { quote, charges } = fixture();
    quote.evidence.lines.push({
      id: "discount",
      selectionId: null,
      kind: "discount",
      amountMinor: "1000",
    });
    Object.assign(quote.evidence, { totalMinor: "35000", dueLaterMinor: "24200" });
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    expect(pricingRoomRevenueProjection(quote, charges)).toBeNull();
  });
  it("rejects an included charge even when its aggregate incorrectly says zero", () => {
    const { quote, charges } = fixture();
    const included = {
      ...charges,
      charges: [
        { id: "tax", included: true, amountMinor: "100", basisEvidenceId: charges.basisEvidenceId },
      ],
    };
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    expect(pricingRoomRevenueProjection(quote, included)).toBeNull();
  });
  it.each([
    undefined,
    { version: "wrong" },
    { currency: "USD" },
    { requestKey: "other" },
    { sourceRevision: "stale" },
    { basisEvidenceId: "other" },
    { includedChargeMinor: "1" },
    { additionalChargeMinor: "1" },
    { charges: [{ id: "tax", included: true, amountMinor: "1" }] },
  ])("rejects missing or inconsistent retained charge evidence %j", (change) => {
    const { quote, charges } = fixture();
    expect(
      pricingRoomRevenueProjection(
        quote,
        change === undefined ? undefined : { ...charges, ...change },
      ),
    ).toBeNull();
  });
  it("rejects a valid quote amount exceeding the ledger numeric precision", () => {
    const { quote, charges } = fixture("JPY");
    Object.assign(quote.rooms[0].nights[0], {
      roomMinor: "1000000000000000",
      totalMinor: "1000000000003000",
    });
    quote.evidence.lines[0].amountMinor = "1000000000015000";
    Object.assign(quote.evidence, {
      totalMinor: "1000000000021000",
      dueNowMinor: "0",
      dueLaterMinor: "1000000000021000",
    });
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    expect(pricingRoomRevenueProjection(quote, charges)).toBeNull();
  });
  it("rejects missing nightly evidence", () => {
    const { quote, charges } = fixture();
    quote.rooms[0].nights.pop();
    expect(pricingRoomRevenueProjection(quote, charges)).toBeNull();
  });
});
