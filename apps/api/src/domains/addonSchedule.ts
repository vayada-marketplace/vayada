/** VAY-2391: when an add-on happens. Only guest_pick asks the guest for a day. */
export const ADDON_SCHEDULE_MODES = [
  "arrival",
  "departure",
  "guest_pick",
  "daily",
  "anytime",
] as const;
export type AddonScheduleMode = (typeof ADDON_SCHEDULE_MODES)[number];

/** ISO weekdays: 1 is Monday, 7 is Sunday. */
export const ADDON_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function isAddonScheduleMode(value: unknown): value is AddonScheduleMode {
  return (ADDON_SCHEDULE_MODES as readonly unknown[]).includes(value);
}

const perNight = (pricingModel: string) =>
  pricingModel === "per_night" || pricingModel === "per_guest_night";

/** A new add-on's mode when the host picks none: every day for a per-night price, the arrival day for
 * transport, otherwise the guest picks a day (the 0525 backfill rule). */
export function defaultAddonScheduleMode(
  pricingModel: string,
  category: string | null | undefined,
): AddonScheduleMode {
  if (perNight(pricingModel)) return "daily";
  return category?.trim().toLowerCase() === "transport" ? "arrival" : "guest_pick";
}

/**
 * The mode to save with this price. A per-night price is always daily, and daily needs a per-night price
 * (Flamur, 2026-10-28). `chosen` is the host's pick: null when it breaks that rule. Without one, the saved
 * mode stays if it still fits the price, otherwise the default takes over.
 */
export function resolveAddonScheduleMode(input: {
  pricingModel: string;
  category: string | null | undefined;
  chosen?: AddonScheduleMode;
  saved?: AddonScheduleMode;
}): AddonScheduleMode | null {
  const nightly = perNight(input.pricingModel);
  if (input.chosen !== undefined)
    return (input.chosen === "daily") === nightly ? input.chosen : null;
  if (input.saved !== undefined && (input.saved === "daily") === nightly) return input.saved;
  return defaultAddonScheduleMode(input.pricingModel, input.category);
}

/** One to seven distinct ISO weekdays, sorted; null otherwise. */
export function parseBookableWeekdays(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 7 ||
    !value.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) ||
    new Set(value).size !== value.length
  )
    return null;
  return [...(value as number[])].sort((a, b) => a - b);
}

/**
 * A stored add-on's schedule as readers use it. A per-night price reads as daily whatever is stored, and a
 * one-off price never does (it falls back to the guest picking a day). Values that are absent read as the
 * column defaults: guest_pick on every weekday. Null when a stored value is invalid.
 */
export function readAddonSchedule(
  pricingModel: string,
  mode: unknown,
  weekdays: unknown,
): { scheduleMode: AddonScheduleMode; bookableWeekdays: number[] } | null {
  const stored = mode ?? "guest_pick";
  // The column's CHECK allows a weekday twice; that still means the same days.
  const bookableWeekdays =
    weekdays === undefined || weekdays === null
      ? [...ADDON_WEEKDAYS]
      : parseBookableWeekdays(Array.isArray(weekdays) ? [...new Set(weekdays)] : weekdays);
  if (!isAddonScheduleMode(stored) || !bookableWeekdays) return null;
  const scheduleMode = perNight(pricingModel)
    ? "daily"
    : stored === "daily"
      ? "guest_pick"
      : stored;
  return { scheduleMode, bookableWeekdays };
}

/** The day a one-off add-on is booked for when the guest sends none: check-in for arrival, check-out for
 * departure, none ([]) for anytime. Null for guest_pick, where the guest has to pick. */
export function addonScheduledDates(
  mode: AddonScheduleMode,
  stay: { checkIn: string; checkOut: string },
): string[] | null {
  if (mode === "arrival") return [stay.checkIn];
  if (mode === "departure") return [stay.checkOut];
  if (mode === "anytime") return [];
  return null;
}
