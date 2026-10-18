import { describe, expect, it } from "vitest";

import {
  defaultPaidWhenBookingPayment,
  paidWhenBooking,
  paidWhenBookingChoices,
  paymentForChoice,
  pricingPaymentWriteProblem,
} from "./pricingPaidWhenBooking.js";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";

type Payment = ReplacementOfferTerms["payment"];
const full = (...acceptedMethods: NonNullable<Payment["acceptedMethods"]>): Payment => ({
  kind: "full",
  acceptedMethods,
});
const deposit = (extra: Partial<Extract<Payment, { kind: "deposit" }>> = {}): Payment => ({
  kind: "deposit",
  basisPoints: 3000,
  balanceDaysBeforeArrival: 0,
  acceptedMethods: ["card"],
  ...extra,
});

describe("paidWhenBooking", () => {
  it("reads the choice from the stored terms", () => {
    expect(paidWhenBooking(full("pay_at_property"))).toBe("nothing");
    expect(paidWhenBooking(full("card"))).toBe("full_stay");
    expect(paidWhenBooking(full("card", "bank_transfer", "paypal"))).toBe("full_stay");
    expect(paidWhenBooking(full("bank_transfer"))).toBe("full_stay");
    expect(paidWhenBooking(deposit())).toBe("deposit");
  });

  it("names what only stored terms hold", () => {
    expect(paidWhenBooking(full("pay_at_property", "card"))).toBe("guest_chooses");
    expect(paidWhenBooking(full("card", "pay_at_property", "bank_transfer"))).toBe("guest_chooses");
    expect(paidWhenBooking({ kind: "full" })).toBe("not_set");
    expect(
      paidWhenBooking({ kind: "deposit", basisPoints: 2000, balanceDaysBeforeArrival: 7 }),
    ).toBe("deposit");
  });
});

describe("paymentForChoice", () => {
  it("writes each choice and reads back the same choice", () => {
    for (const [choice, input] of [
      ["nothing", { methods: ["pay_at_property", "card"] }],
      ["full_stay", { methods: ["pay_at_property", "card", "paypal"] }],
      ["deposit", { methods: [], depositPercent: 30 }],
    ] as const) {
      const payment = paymentForChoice(choice, input);
      expect(payment && paidWhenBooking(payment)).toBe(choice);
      expect(payment && pricingPaymentWriteProblem(payment)).toBeNull();
    }
    expect(paymentForChoice("nothing", { methods: [] })).toEqual(full("pay_at_property"));
    expect(
      paymentForChoice("full_stay", { methods: ["paypal", "pay_at_property", "card"] }),
    ).toEqual(full("card", "paypal"));
    expect(paymentForChoice("deposit", { methods: ["bank_transfer"], depositPercent: 25 })).toEqual(
      deposit({ basisPoints: 2500 }),
    );
  });

  it("refuses what it can't write", () => {
    expect(paymentForChoice("full_stay", { methods: ["pay_at_property"] })).toBeNull();
    for (const depositPercent of [undefined, 0, 100, 12.5, -1])
      expect(paymentForChoice("deposit", { methods: ["card"], depositPercent })).toBeNull();
  });
});

describe("choices and defaults", () => {
  it("offers non-refundable rates no Nothing", () => {
    expect(paidWhenBookingChoices("flexible")).toEqual(["nothing", "deposit", "full_stay"]);
    expect(paidWhenBookingChoices("non_refundable")).toEqual(["deposit", "full_stay"]);
  });

  it("starts flexible rates at the property and the rest in full when booking", () => {
    const ready = ["pay_at_property", "card", "bank_transfer"] as const;
    expect(defaultPaidWhenBookingPayment("flexible", ready)).toEqual(full("pay_at_property"));
    expect(defaultPaidWhenBookingPayment("non_refundable", ready)).toEqual(
      full("card", "bank_transfer"),
    );
    expect(defaultPaidWhenBookingPayment("flexible", ["card"])).toEqual(full("card"));
    expect(defaultPaidWhenBookingPayment("non_refundable", ["pay_at_property"])).toBeNull();
    expect(defaultPaidWhenBookingPayment("flexible", [])).toBeNull();
  });
});

describe("pricingPaymentWriteProblem", () => {
  it("allows today's full payments, guest choice included", () => {
    expect(pricingPaymentWriteProblem(full("pay_at_property", "card"))).toBeNull();
    expect(pricingPaymentWriteProblem(full("bank_transfer"))).toBeNull();
  });

  it("names the rule a write breaks", () => {
    expect(pricingPaymentWriteProblem({ kind: "full" })).toBe("payment_methods_required");
    expect(pricingPaymentWriteProblem(deposit({ acceptedMethods: undefined }))).toBe(
      "payment_methods_required",
    );
    expect(
      pricingPaymentWriteProblem(deposit({ acceptedMethods: ["card", "pay_at_property"] })),
    ).toBe("deposit_card_only");
    expect(pricingPaymentWriteProblem(deposit({ acceptedMethods: ["bank_transfer"] }))).toBe(
      "deposit_card_only",
    );
    expect(pricingPaymentWriteProblem(deposit({ balanceDaysBeforeArrival: 7 }))).toBe(
      "deposit_rest_at_property",
    );
    expect(pricingPaymentWriteProblem(deposit({ basisPoints: 10000 }))).toBe(
      "deposit_below_full_stay",
    );
    expect(pricingPaymentWriteProblem(deposit({ basisPoints: 1 }))).toBeNull();
  });
});
