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

/** A discount line as the quote composes it, taken off the total (all of it due later). */
function discount(quote: Mutable<StoredPricingQuote>, selectionId: string | null, amount: string) {
  quote.evidence.lines.push({
    id: `d:${selectionId}`,
    selectionId,
    kind: "discount",
    amountMinor: amount,
  });
  const total = (BigInt(quote.evidence.totalMinor) - BigInt(amount)).toString();
  Object.assign(quote.evidence, { totalMinor: total, dueNowMinor: "0", dueLaterMinor: total });
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
  it("rejects a code's discount without the rooms it applies to", () => {
    const { quote, charges } = fixture();
    discount(quote, null, "1000");
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    expect(pricingRoomRevenueProjection(quote, charges)).toBeNull();
    for (const code of [null, {}, { eligibleSelectionIds: [] }, { eligibleSelectionIds: ["x"] }])
      expect(pricingRoomRevenueProjection(quote, charges, code)).toBeNull();
  });
  it("takes a code's discount off the nights of its rooms, after their last-minute (VAY-2566)", () => {
    const { quote, charges } = fixture();
    discount(quote, "one", "3000");
    discount(quote, null, "2701");
    expect(
      pricingRoomRevenueProjection(quote, charges, {
        eligibleSelectionIds: ["one"],
      })?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["121.49", "121.50"]);
  });
  it("takes a room's last-minute discount off its own nights by price (VAY-2566)", () => {
    const { quote, charges } = fixture();
    Object.assign(quote.rooms[0].nights[0], { roomMinor: "14001", totalMinor: "17001" });
    Object.assign(quote.rooms[0].nights[1], { roomMinor: "15999", totalMinor: "18999" });
    discount(quote, "one", "3000");
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    // 1400.1 and 1599.9: the larger remainder takes the last cent, and the nights add up to
    // the room less its discount (300.00 - 30.00).
    expect(
      pricingRoomRevenueProjection(quote, charges)?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["126.01", "143.99"]);
  });
  it("gives an equal remainder to the earlier night and allows a fully discounted room", () => {
    const { quote, charges } = fixture();
    discount(quote, "one", "3001");
    expect(
      pricingRoomRevenueProjection(quote, charges)?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["134.99", "135.00"]);
    const free = fixture();
    discount(free.quote, "one", "30000");
    expect(
      pricingRoomRevenueProjection(free.quote, free.charges)?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["0.00", "0.00"]);
  });
  it("splits an IDR discount in whole rupiah", () => {
    const { quote, charges } = fixture("IDR");
    discount(quote, "one", "100");
    expect(
      pricingRoomRevenueProjection(quote, charges)?.nights.map((n) => n.grossRoomAmount),
    ).toEqual(["149.00", "150.00"]);
  });
  it("keeps another room's nights whole when only one room has a discount", () => {
    const { quote } = fixture();
    quote.stay.rooms.push({ ...quote.stay.rooms[0], selectionId: "two" });
    quote.rooms.push({ ...structuredClone(quote.rooms[0]), selectionId: "two" });
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
    discount(quote, "two", "1000");
    expect(parseStoredPricingQuote(quote)).not.toBeNull();
    expect(
      pricingRoomRevenueProjection(quote, charges)?.nights.map((n) => [
        n.roomPositions,
        n.grossRoomAmount,
      ]),
    ).toEqual([
      [[1], "150.00"],
      [[1], "150.00"],
      [[2], "145.00"],
      [[2], "145.00"],
    ]);
  });
  it("takes a code's discount off its own rooms first, and the rest off the others' nights", () => {
    const twoRooms = () => {
      const { quote } = fixture();
      quote.stay.rooms.push({ ...quote.stay.rooms[0], selectionId: "two" });
      quote.rooms.push({ ...structuredClone(quote.rooms[0]), selectionId: "two" });
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
      return { quote, charges };
    };
    const code = { eligibleSelectionIds: ["two"] };
    const own = twoRooms();
    discount(own.quote, null, "1000");
    expect(
      pricingRoomRevenueProjection(own.quote, own.charges, code)?.nights.map(
        (n) => n.grossRoomAmount,
      ),
    ).toEqual(["150.00", "150.00", "145.00", "145.00"]);
    // A fixed code bigger than its room (its extras' share): the other room's nights take the rest.
    const spill = twoRooms();
    discount(spill.quote, null, "40000");
    expect(
      pricingRoomRevenueProjection(spill.quote, spill.charges, code)?.nights.map(
        (n) => n.grossRoomAmount,
      ),
    ).toEqual(["100.00", "100.00", "0.00", "0.00"]);
    // More than all the rooms together has nowhere to go.
    const over = twoRooms();
    discount(over.quote, null, "60001");
    expect(pricingRoomRevenueProjection(over.quote, over.charges, code)).toBeNull();
  });
  it("rejects a room discount larger than the room or naming a room not in the stay", () => {
    const over = fixture();
    discount(over.quote, "one", "30001");
    expect(pricingRoomRevenueProjection(over.quote, over.charges)).toBeNull();
    const elsewhere = fixture();
    discount(elsewhere.quote, "other", "1000");
    expect(pricingRoomRevenueProjection(elsewhere.quote, elsewhere.charges)).toBeNull();
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
