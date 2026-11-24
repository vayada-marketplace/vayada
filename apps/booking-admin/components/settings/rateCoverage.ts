import type {
  RatePaymentCoverage,
  RatePaymentCoverageRate,
} from "@/services/api/financePaymentSettingsClient";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const METHOD_LABEL: Record<string, string> = {
  card: "settings.billing.onlineCard",
  pay_at_property: "settings.billing.payAtHotel",
  bank_transfer: "settings.billing.bankTransfer",
  paypal: "settings.payments.paypal",
};

/** VAY-2583: each booking-page rate with the ways its own terms accept, e.g. "Villa One · Flexible:
 * Pay at hotel; Villa Two · Non-refundable: Credit card, Bank transfer". */
export function describeRateMethods(
  rates: readonly RatePaymentCoverageRate[],
  t: Translate,
): string {
  return rates
    .map((rate) => {
      const kind = t(
        rate.cancellation === "non_refundable"
          ? "settings.billing.rateNonRefundable"
          : "settings.billing.rateFlexible",
      );
      const methods = rate.acceptedMethods.map((method) =>
        METHOD_LABEL[method] ? t(METHOD_LABEL[method]) : method,
      );
      return `${rate.roomName ? `${rate.roomName} · ` : ""}${kind}: ${methods.join(", ")}`;
    })
    .join("; ");
}

/** VAY-2583: what Payments says about the hotel's booking-page rates: guests can pay for none of
 * them (the page lists no rooms), or Credit card is on and ready but no rate takes it. Null:
 * nothing to say. `cardBlocked`: card isn't ready, which its own banner already explains. */
export function rateCoverageNote(
  coverage: RatePaymentCoverage | null,
  cardOn: boolean,
  cardBlocked: boolean,
): { message: string; rates: RatePaymentCoverageRate[] } | null {
  if (!coverage?.rates.length) return null;
  if (coverage.payable === 0)
    return { message: "settings.billing.noRatePayable", rates: coverage.rates };
  if (
    cardOn &&
    !cardBlocked &&
    !coverage.rates.some((rate) => rate.acceptedMethods.includes("card"))
  )
    return { message: "settings.billing.cardNotOnRates", rates: coverage.rates };
  return null;
}
