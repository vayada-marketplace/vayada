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

type ManualMethod = "bank_transfer" | "paypal";
/** The first property-local arrival date (YYYY-MM-DD) each bank-transfer or PayPal method can be
 * booked for: its payment deadline must end before check-in (VAY-2145). */
export type ManualEarliestArrival = Partial<Record<ManualMethod, string>>;
export type BookingPagePayment = {
  methods: PricingPaymentMethod[];
  earliestArrival: ManualEarliestArrival;
  /** The hotel's own Terms & Conditions; null when it has none or they can't be read (VAY-2176). */
  termsText: string | null;
};

/** The payment methods /book offers, from the hotel's checkout settings (VAY-2139). */
export async function getBookingPagePayment(
  slug: string,
  signal?: AbortSignal,
): Promise<BookingPagePayment> {
  let config: Record<string, unknown> | null = null;
  try {
    config = await bookingWebPublic.get<Record<string, unknown>>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
      { signal, cache: "no-store" },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const terms = config?.termsText;
  const termsText = typeof terms === "string" && terms.trim() ? terms.trim() : null;
  // An empty list means the hotel offers no method here; only a missing list means an older API.
  const methods = config?.bookingPagePaymentMethods;
  if (Array.isArray(methods) && methods.every(isPricingPaymentMethod))
    return {
      methods: Array.from(new Set(methods)),
      earliestArrival: earliestArrival(config?.manualPaymentEarliestArrival),
      termsText,
    };
  return { methods: [...DEFAULT_METHODS], earliestArrival: {}, termsText };
}

export async function getBookingPagePaymentMethods(
  slug: string,
  signal?: AbortSignal,
): Promise<PricingPaymentMethod[]> {
  return (await getBookingPagePayment(slug, signal)).methods;
}

/** The methods for this arrival date: bank transfer and PayPal only from their earliest date. */
export function bookingPageMethodsForArrival(
  { methods, earliestArrival: earliest }: Pick<BookingPagePayment, "methods" | "earliestArrival">,
  checkIn: string,
): PricingPaymentMethod[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) return methods;
  return methods.filter((method) => {
    if (method !== "bank_transfer" && method !== "paypal") return true;
    const from = earliest[method];
    return !from || checkIn >= from;
  });
}

function earliestArrival(value: unknown): ManualEarliestArrival {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ManualEarliestArrival = {};
  for (const method of ["bank_transfer", "paypal"] as const) {
    const date = (value as Record<string, unknown>)[method];
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) result[method] = date;
  }
  return result;
}
