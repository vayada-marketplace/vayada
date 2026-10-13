import {
  isPricingPaymentMethod,
  type PricingPaymentMethod,
} from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

/** Older APIs list no booking-page methods; this page then offered card and pay at property. */
const DEFAULT_METHODS: readonly PricingPaymentMethod[] = ["card", "pay_at_property"];

export const bookingPagePaymentMethodLabels: Record<PricingPaymentMethod, string> = {
  card: "Card",
  pay_at_property: "Pay at property",
  bank_transfer: "Bank transfer",
  paypal: "PayPal",
};

/** The payment methods /book offers, from the hotel's checkout settings (VAY-2139). */
export async function getBookingPagePaymentMethods(
  slug: string,
  signal?: AbortSignal,
): Promise<PricingPaymentMethod[]> {
  try {
    const config = await bookingWebPublic.get<Record<string, unknown>>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
      { signal, cache: "no-store" },
    );
    // An empty list means the hotel offers no method here; only a missing list means an older API.
    const methods = config?.bookingPagePaymentMethods;
    if (Array.isArray(methods) && methods.every(isPricingPaymentMethod))
      return Array.from(new Set(methods));
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return [...DEFAULT_METHODS];
}
