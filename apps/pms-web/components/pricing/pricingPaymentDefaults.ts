import type { ManualPaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import type { PricingCardReadiness } from "@vayada/product-onboarding/replacementPricingClient";
import { bookingsService } from "@/services/bookings";
import type { PaymentMethod } from "./AcceptedPaymentMethods";

/** The ways to pay the hotel can take now (VAY-2188), the rule setup's pricing step uses too: pay at the hotel when
 * it is on, card once the booking page can take it (Stripe, Vayada's approval and the switch, VAY-2205), and bank
 * transfer and PayPal when they are ready (VAY-2139).
 * A first price accepts them, so the hotel isn't asked again. Null when they can't be read (no Finance access,
 * offline) or none is ready: the form then asks. */
export async function paymentSettingsMethods(client: {
  paymentMethods(): Promise<ManualPaymentMethod[]>;
  cardReadiness(): Promise<PricingCardReadiness>;
}): Promise<PaymentMethod[] | null> {
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
    return methods.length ? methods : null;
  } catch {
    return null;
  }
}
