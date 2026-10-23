import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { describe, expect, it } from "vitest";
import {
  pricingPaymentsNow,
  pricingRateNotSelling,
  pricingRatePaymentMethods,
  pricingRateSells,
  type PricingCardState,
} from "./pricingRatePayability.js";

const flexible = {
  kind: "flexible",
  terms: {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  },
} as const;
const rate = (
  payment: ReplacementOfferTerms["payment"],
  cancellation: ReplacementOfferTerms["cancellation"] = flexible,
): ReplacementOfferTerms => ({
  roomTypeId: "11111111-1111-4111-8111-111111111111",
  offerId: "flex",
  revision: "22222222-2222-4222-8222-222222222222",
  cancellation,
  payment,
});
const nonRefundable = { kind: "non_refundable" } as const;
const cardDeposit = {
  kind: "deposit",
  basisPoints: 3000,
  balanceDaysBeforeArrival: 0,
  acceptedMethods: ["card"],
} as const;
const all = { card: true, deposits: true, manual: [] } as const;

// VAY-2304: a rate nobody can pay stops selling; every other rate keeps selling.
describe("which published rates sell", () => {
  it("applies the booking page's switches to Finance's ready methods", () => {
    expect(
      pricingPaymentsNow(["pay_at_property", "card", "bank_transfer", "paypal"], {
        card: false,
        deposits: true,
        manual: ["paypal"],
      }),
    ).toEqual({ methods: ["pay_at_property", "paypal"], deposits: false });
    expect(pricingPaymentsNow(["card"], all)).toEqual({ methods: ["card"], deposits: true });
  });

  it("sells a rate any of whose methods is ready, and a card deposit only with deposits on", () => {
    const card = { methods: ["card", "pay_at_property"] as const, deposits: true };
    expect(pricingRateSells(rate({ kind: "full", acceptedMethods: ["card"] }), card)).toBe(true);
    expect(
      pricingRateSells(rate({ kind: "full", acceptedMethods: ["card", "pay_at_property"] }), {
        methods: ["pay_at_property"],
        deposits: false,
      }),
    ).toBe(true);
    expect(pricingRateSells(rate(cardDeposit), card)).toBe(true);
    expect(pricingRateSells(rate(cardDeposit), { ...card, deposits: false })).toBe(false);
    // A deposit shape the booking page can't run (the rest later) doesn't sell.
    expect(pricingRateSells(rate({ ...cardDeposit, balanceDaysBeforeArrival: 7 }), card)).toBe(
      false,
    );
    // Old terms without methods, and methods the hotel can't take now, don't sell.
    expect(pricingRateSells(rate({ kind: "full" }), card)).toBe(false);
    expect(pricingRateSells(rate({ kind: "full", acceptedMethods: ["paypal"] }), card)).toBe(false);
  });

  it("names the ways guests can pay a rate now, in the hotel's order (VAY-2309)", () => {
    const now = { methods: ["pay_at_property", "card", "paypal"] as const, deposits: true };
    expect(
      pricingRatePaymentMethods(
        rate({ kind: "full", acceptedMethods: ["card", "paypal", "pay_at_property"] }),
        now,
      ),
    ).toEqual(["pay_at_property", "card", "paypal"]);
    expect(
      pricingRatePaymentMethods(rate({ kind: "full", acceptedMethods: ["card"] }, nonRefundable), {
        ...now,
        methods: ["pay_at_property"],
      }),
    ).toEqual([]);
    expect(pricingRatePaymentMethods(rate(cardDeposit), now)).toEqual(["card"]);
    expect(pricingRatePaymentMethods(rate(cardDeposit), { ...now, deposits: false })).toEqual([]);
    expect(pricingRatePaymentMethods(rate({ kind: "full" }), now)).toEqual([]);
  });

  it("names the reason and the fixes, main fix first", () => {
    const at = (card: PricingCardState, methods: ("card" | "pay_at_property")[]) => ({
      methods,
      deposits: card === "ready",
      card,
    });
    const cardOnly = rate({ kind: "full", acceptedMethods: ["card"] });
    expect(pricingRateNotSelling(cardOnly, at("ready", ["card"]))).toBeNull();
    expect(pricingRateNotSelling(cardOnly, at("off", ["pay_at_property"]))).toEqual({
      reason: "card_off",
      fixes: ["turn_card_on", "allow_pay_at_property"],
    });
    expect(pricingRateNotSelling(cardOnly, at("not_chosen", []))).toEqual({
      reason: "card_not_chosen",
      fixes: ["choose_card"],
    });
    expect(pricingRateNotSelling(cardOnly, at("setup_incomplete", ["pay_at_property"]))).toEqual({
      reason: "card_setup_incomplete",
      fixes: ["finish_stripe_setup", "allow_pay_at_property"],
    });
    // A non-refundable rate is paid in advance: pay at the property is no fix for it.
    expect(
      pricingRateNotSelling(
        rate({ kind: "full", acceptedMethods: ["card"] }, nonRefundable),
        at("off", ["pay_at_property"]),
      ),
    ).toEqual({ reason: "card_off", fixes: ["turn_card_on"] });
    // Nor for a deposit, whose rest is already paid at the property.
    expect(pricingRateNotSelling(rate(cardDeposit), at("off", ["pay_at_property"]))).toEqual({
      reason: "card_off",
      fixes: ["turn_card_on"],
    });
    expect(
      pricingRateNotSelling(rate(cardDeposit), {
        methods: ["card"],
        deposits: false,
        card: "ready",
      }),
    ).toEqual({ reason: "deposits_off", fixes: ["change_rate_payment"] });
    expect(
      pricingRateNotSelling(
        rate({ kind: "full", acceptedMethods: ["pay_at_property"] }),
        at("ready", ["card"]),
      ),
    ).toEqual({ reason: "pay_at_property_off", fixes: ["turn_pay_at_property_on"] });
    for (const payment of [
      { kind: "full" },
      { kind: "full", acceptedMethods: ["bank_transfer"] },
    ] as const)
      expect(
        pricingRateNotSelling(rate(payment), at("ready", ["card", "pay_at_property"])),
      ).toEqual({
        reason: "no_payment_method",
        fixes: ["change_rate_payment"],
      });
  });
});
