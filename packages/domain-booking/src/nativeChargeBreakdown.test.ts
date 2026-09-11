import { describe, expect, it } from "vitest";
import { decomposeNativeCheckoutCharge as decompose } from "./nativeChargeBreakdown.js";
const input = () => ({
  contractVersion: "native-checkout-charge.v1",
  selectedOffer: {},
  totals: {
    currency: "EUR",
    roomTotal: 500,
    taxesAndFees: 50,
    addonTotal: 100,
    discounts: 0,
    promoDiscount: 0,
    totalAmount: 650,
  },
});
describe("native reported charge breakdown", () => {
  it("keeps room, taxes/fees and extras separate without certifying tax treatment", () => {
    expect(decompose(input())).toEqual({
      status: "reported_components",
      currency: "EUR",
      scale: 2,
      reportedRoomMinor: "50000",
      reportedTaxesAndFeesMinor: "5000",
      reportedExtrasMinor: "10000",
      totalMinor: "65000",
      taxClassification: "unverified",
    });
  });
  it.each([{ discounts: 50 }, { promotionDiscount: 50 }])(
    "subtracts a room discount once: %j",
    (discount) => {
      const source = input();
      expect(
        decompose({ ...source, totals: { ...source.totals, ...discount, totalAmount: 600 } }),
      ).toMatchObject({ reportedRoomMinor: "45000" });
    },
  );
  it("leaves booking-wide promo allocation pending when non-room charges exist", () => {
    const source = input();
    expect(
      decompose({ ...source, totals: { ...source.totals, promoDiscount: 50, totalAmount: 600 } }),
    ).toEqual({ status: "pending", reason: "promo_allocation_required" });
    expect(
      decompose({
        ...source,
        totals: {
          ...source.totals,
          taxesAndFees: 0,
          addonTotal: 0,
          promoDiscount: 50,
          totalAmount: 450,
        },
      }),
    ).toMatchObject({ reportedRoomMinor: "45000", taxClassification: "unverified" });
  });
  it.each([null, -1, "0.001", "1e2", Number.NaN, "9007199254740993"])(
    "rejects malformed room amount %s",
    (roomTotal) => {
      const source = input();
      expect(decompose({ ...source, totals: { ...source.totals, roomTotal } })).toMatchObject({
        status: "needs_review",
      });
    },
  );
  it("rejects mismatched totals and simultaneous automatic/promo discounts", () => {
    const source = input();
    for (const change of [
      { totalAmount: 1 },
      { discounts: 501, totalAmount: 149 },
      { promoDiscount: 10, promotionDiscount: 10, totalAmount: 630 },
    ])
      expect(decompose({ ...source, totals: { ...source.totals, ...change } })).toMatchObject({
        status: "needs_review",
      });
  });
  it("does not reinterpret mixed or different producer versions", () => {
    expect(decompose({ ...input(), contractVersion: "future" })).toMatchObject({
      reason: "unsupported_source",
    });
    expect(decompose({ ...input(), selectedOffer: { roomSelection: {} } })).toMatchObject({
      reason: "mixed_allocation_required",
    });
  });
  it("retains exact decimal cents", () => {
    expect(
      decompose({
        ...input(),
        totals: {
          currency: "EUR",
          roomTotal: "0.29",
          taxesAndFees: "0.01",
          addonTotal: 0,
          discounts: 0,
          promoDiscount: 0,
          totalAmount: "0.30",
        },
      }),
    ).toMatchObject({ reportedRoomMinor: "29", totalMinor: "30" });
  });
});
