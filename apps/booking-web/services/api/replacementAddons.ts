import { pricingCurrencyScale } from "@vayada/domain-booking/replacement-pricing";
import { bookingWebPublic } from "./client";

/** VAY-2391: when an extra happens. Only "guest_pick" asks the guest for a day. */
export type AddonScheduleMode = "arrival" | "departure" | "guest_pick" | "daily" | "anytime";
const scheduleModes: readonly unknown[] = [
  "arrival",
  "departure",
  "guest_pick",
  "daily",
  "anytime",
];

export type PricingAddon = {
  id: string;
  name: string;
  currency: string;
  pricingModel: "per_stay" | "per_night" | "per_guest" | "per_guest_night";
  maxQuantity: number;
  maxGuests: number | null;
  /** VAY-2232: the notice the hotel asks for, in hours; null for none. */
  leadTimeHours: number | null;
  /** The first property-local check-in date the add-on can be added for; null when it needs no
   * notice or the hotel's time zone is unknown. */
  bookableFrom: string | null;
  /** VAY-2391: when it happens; a per-night price is always "daily". */
  scheduleMode: AddonScheduleMode;
  /** ISO weekdays (1 Monday … 7 Sunday) a guest can pick for "guest_pick", sorted. */
  bookableWeekdays: number[];
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
  return raw.addons.flatMap((addon): PricingAddon[] => {
    // Older APIs send neither: then the add-on needs no notice.
    const leadTimeHours = object(addon) ? (addon.leadTimeHours ?? null) : null,
      bookableFrom = object(addon) ? (addon.bookableFrom ?? null) : null;
    // An API from before VAY-2391 sends neither: a per-night extra is every night, any other the
    // guest gives a day for, on any weekday.
    const perNight = object(addon) && String(addon.pricingModel).endsWith("night");
    const scheduleMode = object(addon)
      ? (addon.scheduleMode ?? (perNight ? "daily" : "guest_pick"))
      : null;
    const bookableWeekdays = object(addon)
      ? (addon.bookableWeekdays ?? [1, 2, 3, 4, 5, 6, 7])
      : null;
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
      !(addon.maxGuests === null || limit(addon.maxGuests)) ||
      !(leadTimeHours === null || (limit(leadTimeHours) && leadTimeHours <= 8760)) ||
      !(
        bookableFrom === null ||
        (typeof bookableFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bookableFrom))
      )
    )
      throw new Error("Extra options could not be verified.");
    ids.add(addon.id);
    // A schedule this page doesn't know (a newer API's) leaves out that extra only.
    if (
      !scheduleModes.includes(scheduleMode) ||
      (scheduleMode === "daily") !== perNight ||
      !Array.isArray(bookableWeekdays) ||
      !bookableWeekdays.length ||
      bookableWeekdays.some(
        (day, i) =>
          !Number.isInteger(day) || day < 1 || day > 7 || (i > 0 && day <= bookableWeekdays[i - 1]),
      )
    )
      return [];
    return [
      {
        id: addon.id,
        name: addon.name,
        currency: addon.currency,
        pricingModel: addon.pricingModel as PricingAddon["pricingModel"],
        maxQuantity: addon.maxQuantity,
        maxGuests: addon.maxGuests,
        leadTimeHours,
        bookableFrom,
        scheduleMode: scheduleMode as AddonScheduleMode,
        bookableWeekdays: bookableWeekdays as number[],
      },
    ];
  });
}
