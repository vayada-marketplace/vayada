import {
  isPricingPaymentMethod,
  type PricingPaymentMethod,
} from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

/** Older APIs list no booking-page methods; this page then offered card and pay at property. */
const DEFAULT_METHODS: readonly PricingPaymentMethod[] = ["card", "pay_at_property"];

export const bookingPagePaymentMethodLabels: Record<PricingPaymentMethod, string> = {
  card: "Card",
  pay_at_property: "Pay at the hotel",
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
  /** How the extras step shows each extra, by id (VAY-2195). */
  extras: Record<string, ExtraDisplay>;
  /** The hotel's "group add-ons by category" setting: the category filter on the extras step. */
  groupExtras: boolean;
};

/** An extra's photos, words, category and display price from the hotel's checkout settings. The
 * pricing-addons catalogue decides what can be booked and the quote decides the price. */
export type ExtraDisplay = {
  description: string;
  /** The cover photo, also first in photos. */
  image: string | null;
  /** VAY-2231: every photo the details show. */
  photos: string[];
  duration: string | null;
  location: string | null;
  category: "dining" | "experience" | "transport" | "wellness" | "other";
  price: number | null;
};
const categories: readonly ExtraDisplay["category"][] = [
  "dining",
  "experience",
  "transport",
  "wellness",
  "other",
];

/** A photo next/image may load: this site's own files or the hosts next.config allows. */
function photoUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (/^\/[^/\\]/.test(url)) return true;
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" &&
      (["api.vayada.com", "cdn.vayada.com", "images.vayada.com", "images.unsplash.com"].includes(
        hostname,
      ) ||
        hostname.endsWith(".amazonaws.com"))
    );
  } catch {
    return false;
  }
}

function extraDisplay(value: unknown): Record<string, ExtraDisplay> {
  const result: Record<string, ExtraDisplay> = {};
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "string") continue;
    const photos = Array.from(
      new Set([v.image, ...(Array.isArray(v.images) ? v.images : [])].filter(photoUrl)),
    );
    const price = typeof v.price === "string" ? Number(v.price) : v.price;
    const words = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : null;
    result[v.id] = {
      description: typeof v.description === "string" ? v.description.trim() : "",
      image: photos[0] ?? null,
      photos,
      duration: words(v.duration),
      location: words(v.location),
      category: categories.includes(v.category as ExtraDisplay["category"])
        ? (v.category as ExtraDisplay["category"])
        : "other",
      price: typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null,
    };
  }
  return result;
}

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
  const extras = extraDisplay(config?.addons);
  const groupExtras = config?.groupAddonsByCategory !== false;
  // An empty list means the hotel offers no method here; only a missing list means an older API.
  const methods = config?.bookingPagePaymentMethods;
  if (Array.isArray(methods) && methods.every(isPricingPaymentMethod))
    return {
      methods: Array.from(new Set(methods)),
      earliestArrival: earliestArrival(config?.manualPaymentEarliestArrival),
      termsText,
      extras,
      groupExtras,
    };
  return { methods: [...DEFAULT_METHODS], earliestArrival: {}, termsText, extras, groupExtras };
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

/** Until the guest picks how to pay, the price uses the hotel's ways in this order: paying at the
 * hotel first (nothing is charged now), and only ways the chosen rates take when the catalog names
 * them (VAY-2309), so a card-only or non-refundable rate isn't priced at the hotel first. */
export function defaultQuoteMethods(
  available: readonly PricingPaymentMethod[],
  rateMethods: readonly PricingPaymentMethod[] | null,
): PricingPaymentMethod[] {
  const ordered = [...available].sort(
    (a, b) => Number(b === "pay_at_property") - Number(a === "pay_at_property"),
  );
  const taken = rateMethods ? ordered.filter((method) => rateMethods.includes(method)) : [];
  return taken.length ? taken : ordered;
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
