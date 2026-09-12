import { describe, expect, it } from "vitest";
import { createFinancePaymentReadinessSnapshot } from "./paymentReadinessSnapshot.js";
import { parseFinancePaymentReadinessSnapshot } from "./paymentReadinessParsing.js";
import type { FinancePaymentReadinessInput } from "./paymentReadiness.js";

const initial: FinancePaymentReadinessInput = {
  propertyId: "20000000-0000-4000-8000-000000000002",
  paymentMethodsRevision: 0,
  selectedMethods: [],
  committedPricing: null,
  currentPricing: null,
  onlineCardReadiness: "execution_unavailable",
  updatedAt: null,
};
describe("uncommitted Finance payment setup", () => {
  it("round trips a truthful unselected revision-zero snapshot", () => {
    const snapshot = createFinancePaymentReadinessSnapshot(initial);
    expect(parseFinancePaymentReadinessSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      bookingPaymentReady: false,
      readyMethodCount: 0,
      paymentsEnabled: false,
    });
  });
  it.each([
    { selectedMethods: ["pay_at_property"] },
    {
      committedPricing: {
        contractVersion: "pms-pricing.v1",
        currency: "EUR",
        pricingCurrencyRevision: 1,
      },
    },
    { updatedAt: "2026-09-11T00:00:00.000Z" },
  ])("rejects committed state on revision zero: %j", (change) => {
    expect(() =>
      createFinancePaymentReadinessSnapshot({
        ...initial,
        ...change,
      } as FinancePaymentReadinessInput),
    ).toThrow();
  });
});
