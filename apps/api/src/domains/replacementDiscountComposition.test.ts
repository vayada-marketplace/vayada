import { describe, expect, it } from "vitest";
import { composeReplacementDiscounts as compose } from "./replacementDiscountComposition.js";
const percent = (basisPoints: number) => ({ kind: "percentage", basisPoints });
const fixed = (amountMinor: string) => ({ kind: "fixed", amountMinor });
const room = (
  selectionId = "one",
  roomMinor = "10000",
  lastMinute: unknown = percent(1000),
  codeEligible = true,
) => ({ selectionId, roomMinor, lastMinute, codeEligible });
const input = () => ({
  rooms: [room()],
  eligibleAddonMinor: "0",
  code: percent(2000),
  stacking: false,
});
describe("replacement Booking discount composition", () => {
  it("compares independent candidates, preserving the agreed 80 rather than 82 example", () => {
    expect(compose(input())).toEqual({
      version: "booking.discount-components.v1",
      lastMinuteLines: [],
      codeMinor: "2000",
      totalDiscountMinor: "2000",
      remainingRoomAndEligibleAddonMinor: "8000",
    });
    expect(compose({ ...input(), stacking: true })).toMatchObject({
      lastMinuteLines: [{ selectionId: "one", amountMinor: "1000" }],
      codeMinor: "1800",
      totalDiscountMinor: "2800",
      remainingRoomAndEligibleAddonMinor: "7200",
    });
  });
  it("gives last-minute the tie and selects a strictly better code once for the booking", () => {
    expect(compose({ ...input(), code: percent(1000) })).toMatchObject({
      lastMinuteLines: [{ selectionId: "one", amountMinor: "1000" }],
      codeMinor: "0",
    });
    expect(
      compose({ ...input(), rooms: [room("a"), room("b")], code: fixed("3000") }),
    ).toMatchObject({
      lastMinuteLines: [],
      codeMinor: "3000",
      remainingRoomAndEligibleAddonMinor: "17000",
    });
  });
  it("stacks code on eligible discounted rooms plus eligible extras only", () => {
    const selected = {
      ...input(),
      stacking: true,
      eligibleAddonMinor: "2000",
      rooms: [
        room("eligible", "10000", percent(1000)),
        room("excluded", "5000", percent(2000), false),
      ],
    };
    expect(compose(selected)).toMatchObject({
      lastMinuteLines: [
        { selectionId: "eligible", amountMinor: "1000" },
        { selectionId: "excluded", amountMinor: "1000" },
      ],
      codeMinor: "2200",
      totalDiscountMinor: "4200",
      remainingRoomAndEligibleAddonMinor: "12800",
    });
    expect(compose({ ...selected, stacking: false })).toMatchObject({
      lastMinuteLines: [],
      codeMinor: "2400",
      remainingRoomAndEligibleAddonMinor: "14600",
    });
  });
  it("keeps disabled room discounts explicit and allows codes on extras alone", () => {
    expect(
      compose({
        rooms: [room("one", "10000", null, false)],
        eligibleAddonMinor: "2000",
        code: percent(5000),
        stacking: true,
      }),
    ).toMatchObject({
      lastMinuteLines: [],
      codeMinor: "1000",
      remainingRoomAndEligibleAddonMinor: "11000",
    });
    expect(compose({ ...input(), rooms: [room("one", "10000", null)], code: null })).toMatchObject({
      lastMinuteLines: [],
      codeMinor: "0",
      totalDiscountMinor: "0",
      remainingRoomAndEligibleAddonMinor: "10000",
    });
  });
  it("caps fixed reductions at each eligible basis without touching meals or other charges", () => {
    expect(
      compose({
        rooms: [room("one", "100", fixed("500"))],
        eligibleAddonMinor: "30",
        code: fixed("500"),
        stacking: true,
      }),
    ).toMatchObject({
      lastMinuteLines: [{ selectionId: "one", amountMinor: "100" }],
      codeMinor: "30",
      totalDiscountMinor: "130",
      remainingRoomAndEligibleAddonMinor: "0",
    });
    expect(compose({ ...input(), mealMinor: "5000" })).toBeNull();
  });
  it("rounds the remaining price half-up in integer minor units at any currency scale", () => {
    expect(
      compose({ ...input(), rooms: [room("one", "1", percent(5000))], code: null }),
    ).toMatchObject({ totalDiscountMinor: "0", remainingRoomAndEligibleAddonMinor: "1" });
    expect(
      compose({ ...input(), rooms: [room("one", "3", percent(5000))], code: null }),
    ).toMatchObject({ totalDiscountMinor: "1", remainingRoomAndEligibleAddonMinor: "2" });
    expect(
      compose({ ...input(), rooms: [room("one", "999999999999999999", null)], code: fixed("1") }),
    ).toMatchObject({ remainingRoomAndEligibleAddonMinor: "999999999999999998" });
    expect(
      compose({ ...input(), rooms: [room("one", "10", null)], code: percent(10000) }),
    ).toMatchObject({ remainingRoomAndEligibleAddonMinor: "0" });
  });
  it("rejects overflow, omitted owner decisions and malformed inputs", () => {
    for (const invalid of [
      null,
      {},
      { ...input(), stacking: undefined },
      { ...input(), code: undefined },
      { ...input(), eligibleAddonMinor: undefined },
      { ...input(), rooms: [] },
      { ...input(), rooms: [room(), room()] },
      { ...input(), rooms: [room(" ")] },
      { ...input(), rooms: [room("one", "-1")] },
      { ...input(), rooms: [room("one", "01")] },
      { ...input(), rooms: [room("one", "10000", percent(10001))] },
      { ...input(), rooms: [{ ...room(), codeEligible: undefined }] },
      { ...input(), code: fixed("0") },
      { ...input(), code: percent(1.5) },
      { ...input(), code: { ...percent(1000), extra: true } },
      { ...input(), eligibleAddonMinor: "1", rooms: [room("one", "999999999999999999")] },
      { ...input(), rooms: Array.from({ length: 100 }, (_, i) => room(String(i))) },
    ])
      expect(compose(invalid)).toBeNull();
  });
  it("does not modify supplied owner components", () => {
    const original = input(),
      copy = structuredClone(original);
    compose(original);
    expect(original).toEqual(copy);
  });
});
