import type { ManualPaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import type { PricingCardReadiness } from "@vayada/product-onboarding/replacementPricingClient";
import { bookingsService } from "@/services/bookings";
import type { PaymentMethod } from "./AcceptedPaymentMethods";

export type PaymentSettingsDefaults = {
  /** The ways to pay a first price accepts, so the hotel isn't asked again. Null when they can't be read (no
   * Finance access, offline) or none is ready: the form then asks. */
  methods: PaymentMethod[] | null;
  /** The currency Payment settings take, which saved prices must use (null when they couldn't be read). */
  currency: string | null;
  /** Payment settings were read and no way to pay is on: the server refuses to save prices until one is
   * (VAY-2383), so the page says so before the hotel types a price. */
  notReady: boolean;
};

/** What Payment settings give a first price (VAY-2188), which the rule setup's pricing step uses too: pay at the
 * hotel when it is on, card once the booking page can take it (Stripe, Vayada's approval and the switch,
 * VAY-2205), and bank transfer and PayPal when they are ready (VAY-2139). */
export async function paymentSettingsDefaults(client: {
  paymentMethods(): Promise<ManualPaymentMethod[]>;
  cardReadiness(): Promise<PricingCardReadiness>;
}): Promise<PaymentSettingsDefaults> {
  try {
    const [{ paymentSettings }, manual, card] = await Promise.all([
      bookingsService.getPaymentSettings(),
      client.paymentMethods().catch((): ManualPaymentMethod[] => []),
      client.cardReadiness().then(
        (readiness) => readiness.card.ready,
        () => false,
      ),
    ]);
    const methods: PaymentMethod[] = [
      ...(paymentSettings.payAtPropertyEnabled ? (["pay_at_property"] as const) : []),
      ...(paymentSettings.onlineCardPayment && card ? (["card"] as const) : []),
      ...manual,
    ];
    const currency =
      typeof paymentSettings.defaultCurrency === "string" && paymentSettings.defaultCurrency.trim()
        ? paymentSettings.defaultCurrency.trim().toUpperCase()
        : null;
    return { methods: methods.length ? methods : null, currency, notReady: !methods.length };
  } catch {
    return { methods: null, currency: null, notReady: false };
  }
}
