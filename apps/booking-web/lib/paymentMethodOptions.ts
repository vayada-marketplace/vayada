import {
  isManualPricingPaymentMethod,
  type PricingPaymentMethod,
} from "@vayada/domain-booking/replacement-pricing";

/** One way to pay as step 3 shows it (VAY-2347): its card in the list, what it explains once
 * chosen, its lines in the "Your stay" payment box and the main button's words. VAY-2348 adds its
 * methods and their windows by extending this list. */
export type PaymentMethodOption = Readonly<{
  method: PricingPaymentMethod;
  title: string;
  summary: string;
  explanation: string;
  box: readonly { label: string; value: string }[];
  button: string;
  /** The button's words while the booking is being made. */
  busy: string;
}>;

/** The current price's amounts as the guest reads them: the total, the part paid now and the rest
 * paid later ("" while no price is known). */
export type PaymentAmounts = { total: string; now: string; later: string; zero: string };
type Translate = (key: string, values?: Record<string, string>) => string;

/** Each offered way to pay, in the hotel's order. `request`: the hotel accepts each booking itself,
 * so nothing is charged (or only held) until it does; bank transfer and PayPal wait for the
 * payment instead in either mode. `t` reads the `reviewPay` messages. */
export function paymentMethodOptions(
  methods: readonly PricingPaymentMethod[],
  { request, amounts }: { request: boolean; amounts: PaymentAmounts },
  t: Translate,
): PaymentMethodOption[] {
  const { total, now, later, zero } = amounts;
  // A card price can take part now and the rest at the hotel: a deposit or the hotel's own fees.
  const split = !!later && later !== zero;
  return methods.map((method): PaymentMethodOption => {
    const m = (key: string, values?: Record<string, string>) =>
      t(`method.${method}.${key}`, values);
    if (method === "card")
      return {
        method,
        title: m("title"),
        summary: m(request ? "summaryRequest" : "summary"),
        explanation: m(`${request ? "explainRequest" : "explain"}${split ? "Split" : ""}`, {
          now,
          later,
        }),
        box: [
          request ? { label: m("boxHold"), value: now } : { label: m("boxNow"), value: now },
          ...(request ? [{ label: m("boxCharged"), value: m("boxChargedValue") }] : []),
          ...(split ? [{ label: m("boxLater"), value: later }] : []),
        ],
        button: t("buttonCard"),
        busy: t(request ? "busyRequest" : "busyConfirm"),
      };
    const manual = isManualPricingPaymentMethod(method);
    return {
      method,
      title: m("title"),
      summary: m("summary"),
      explanation: m(!manual && request ? "explainRequest" : "explain", { total }),
      box: [
        { label: m("boxNow"), value: zero },
        { label: m("boxLater"), value: total },
      ],
      button: t(!manual && request ? "buttonRequest" : "buttonConfirm"),
      busy: t(!manual && request ? "busyRequest" : "busyConfirm"),
    };
  });
}
