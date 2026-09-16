import { pricingCurrencyScale } from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

export type PricingAddon = {
  id: string;
  name: string;
  currency: string;
  pricingModel: "per_stay" | "per_night" | "per_guest" | "per_guest_night";
  maxQuantity: number;
  maxGuests: number | null;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const limit = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;

/** Selection metadata only: no unit prices or inferred participant/date choices. */
export async function getReplacementAddons(
  slug: string,
  signal?: AbortSignal,
): Promise<PricingAddon[]> {
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-addons`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (!object(raw) || raw.version !== "public-pricing-addons.v1" || !Array.isArray(raw.addons))
    throw new Error("Extra options could not be verified.");
  const ids = new Set<string>();
  return raw.addons.map((addon) => {
    if (
      !object(addon) ||
      typeof addon.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(addon.id) ||
      ids.has(addon.id) ||
      typeof addon.name !== "string" ||
      !addon.name.trim() ||
      typeof addon.currency !== "string" ||
      pricingCurrencyScale(addon.currency) === null ||
      !["per_stay", "per_night", "per_guest", "per_guest_night"].includes(
        String(addon.pricingModel),
      ) ||
      !limit(addon.maxQuantity) ||
      addon.maxQuantity > 99 ||
      !(addon.maxGuests === null || limit(addon.maxGuests))
    )
      throw new Error("Extra options could not be verified.");
    ids.add(addon.id);
    return {
      id: addon.id,
      name: addon.name,
      currency: addon.currency,
      pricingModel: addon.pricingModel as PricingAddon["pricingModel"],
      maxQuantity: addon.maxQuantity,
      maxGuests: addon.maxGuests,
    };
  });
}
