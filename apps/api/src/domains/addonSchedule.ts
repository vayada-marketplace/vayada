import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

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

/** The ISO weekday of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
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

/**
 * The days an add-on's line is for, from the days the guest sent (null: none). Null when they break
 * its schedule (VAY-2391):
 * - guest_pick: exactly one night of the stay, on a weekday it is offered (VAY-2409: also refused
 *   without one, as the booking would be);
 * - the others are dated by when they happen, and days sent for one must be its own: every night for
 *   daily, check-in for arrival, check-out for departure, none for anytime.
 */
export function addonLineDates(
  schedule: { scheduleMode: AddonScheduleMode; bookableWeekdays: readonly number[] },
  sent: readonly string[] | null,
  stay: { checkIn: string; checkOut: string },
): string[] | null {
  const days = sent === null ? null : [...sent].sort();
  if (schedule.scheduleMode === "guest_pick")
    return days?.length === 1 &&
      days[0]! < stay.checkOut &&
      schedule.bookableWeekdays.includes(isoWeekday(days[0]!))
      ? days
      : null;
  const own =
    schedule.scheduleMode === "daily"
      ? Array.from(
          { length: (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000 },
          (_, i) => new Date(Date.parse(stay.checkIn) + i * 86400000).toISOString().slice(0, 10),
        )
      : addonScheduledDates(schedule.scheduleMode, stay)!;
  return days === null || isDeepStrictEqual(days, own) ? own : null;
}

/** VAY-2409: whether every selected add-on's days fit its schedule. Only names the reason a quote was
 * refused; the quote owner enforces the rule. An add-on that is gone is refused for another reason. */
export async function selectedAddonDatesAllow(
  client: Pick<PoolClient, "query">,
  propertyId: string,
  selection: {
    checkIn: string;
    checkOut: string;
    addons: readonly { id: string; dates: readonly string[] | null }[];
  },
): Promise<boolean> {
  if (!selection.addons.length) return true;
  const rows = (
    await client.query(
      `SELECT id::text AS id, pricing_model, schedule_mode, bookable_weekdays
       FROM booking.addon_definitions WHERE property_id=$1 AND id::text = ANY($2::text[])`,
      [propertyId, selection.addons.map((addon) => addon.id.toLowerCase())],
    )
  ).rows;
  return selection.addons.every((addon) => {
    const row = rows.find((candidate) => candidate.id === addon.id.toLowerCase());
    const schedule =
      row && readAddonSchedule(row.pricing_model, row.schedule_mode, row.bookable_weekdays);
    return !schedule || addonLineDates(schedule, addon.dates, selection) !== null;
  });
}
