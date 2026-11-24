import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import {
  FinancePaymentSettingsClientError,
  ratePaymentCoverageRates,
} from "@/services/api/financePaymentSettingsClient";
import { paymentSaveError } from "./paymentSaveError";
import { describeRateMethods, rateCoverageNote } from "./rateCoverage";

const messages = en as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    messages[key] ?? key,
  );
// Aether (VAY-2583): card on and ready, both rates take only pay at the hotel.
const rates = [
  {
    roomName: "Villa One",
    cancellation: "flexible" as const,
    acceptedMethods: ["pay_at_property"],
    payableWith: ["pay_at_property"],
  },
  {
    roomName: "Villa Two",
    cancellation: "non_refundable" as const,
    acceptedMethods: ["bank_transfer", "paypal"],
    payableWith: [],
  },
];

describe("booking-page rates and their ways to pay (VAY-2583)", () => {
  it("names each rate with the ways its terms accept", () => {
    expect(describeRateMethods(rates, t)).toBe(
      "Villa One · Flexible: Pay at hotel; Villa Two · Non-refundable: Bank transfer, PayPal",
    );
  });

  it("says when card is on but no rate takes it, and when no rate can be paid at all", () => {
    const coverage = { rates, payable: 1 };
    expect(rateCoverageNote(coverage, true, false)).toEqual({
      message: "settings.billing.cardNotOnRates",
      rates,
    });
    // Card not ready is its own banner; card off or a rate taking card: nothing to say.
    expect(rateCoverageNote(coverage, true, true)).toBeNull();
    expect(rateCoverageNote(coverage, false, false)).toBeNull();
    const withCard = [{ ...rates[0]!, acceptedMethods: ["pay_at_property", "card"] }, rates[1]!];
    expect(rateCoverageNote({ rates: withCard, payable: 1 }, true, false)).toBeNull();
    // No rate payable: the page lists no rooms, said whatever card does.
    expect(rateCoverageNote({ rates, payable: 0 }, false, false)).toEqual({
      message: "settings.billing.noRatePayable",
      rates,
    });
    expect(rateCoverageNote(null, true, false)).toBeNull();
    expect(rateCoverageNote({ rates: [], payable: 0 }, true, false)).toBeNull();
    for (const key of ["settings.billing.cardNotOnRates", "settings.billing.noRatePayable"])
      expect(t(key, { rates: describeRateMethods(rates, t) })).toContain(
        "Villa One · Flexible: Pay at hotel",
      );
  });

  it("explains a refused save with the rates it named", () => {
    const error = new FinancePaymentSettingsClientError({
      statusCode: 409,
      code: "no_rate_payable",
      category: "conflict",
      detail: "After this change guests couldn't pay for any of your rates.",
      details: rates.map((rate) => ({ ...rate, payableWith: [] })),
    });
    const explained = paymentSaveError(error);
    expect(explained).toMatchObject({
      message: "settings.paymentsSave.noRatePayable",
      retry: false,
    });
    expect(explained.rates?.map((rate) => rate.roomName)).toEqual(["Villa One", "Villa Two"]);
    expect(t(explained.message, { rates: describeRateMethods(explained.rates!, t) })).toBe(
      "Not saved: after this change guests couldn't pay for any of your rates, so your booking page would show no rooms. Your rates take: Villa One · Flexible: Pay at hotel; Villa Two · Non-refundable: Bank transfer, PayPal. Keep one of these on, or first allow another way to pay on your rates in PMS → Prices.",
    );
    // Malformed rates are dropped, never shown half.
    expect(ratePaymentCoverageRates([{ roomName: "X" }, null, "y"])).toEqual([]);
  });
});
