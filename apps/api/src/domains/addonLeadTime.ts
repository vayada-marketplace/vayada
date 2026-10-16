import {
  checkInLeadAllows,
  checkInLeadEarliestArrival,
  type PricingCheckInPlace,
} from "./pricingManualPaymentLead.js";

/** VAY-2232: the notice a host can ask for before an add-on, in hours. No notice is null. */
export const ADDON_LEAD_TIME_HOURS = [12, 24, 48, 72, 168] as const;
export type AddonLeadTimeHours = (typeof ADDON_LEAD_TIME_HOURS)[number];

export function isAddonLeadTimeHours(value: unknown): value is AddonLeadTimeHours {
  return (ADDON_LEAD_TIME_HOURS as readonly unknown[]).includes(value);
}

/**
 * An add-on's stored lead time: `hours` once structured (`metadata.leadTimeHours`, null for none),
 * otherwise the free text hosts typed before VAY-2232 (`legacy`, kept off the booking page until it
 * is converted). A structured value wins over old text. Null when the stored value is invalid.
 */
export function readAddonLeadTime(
  metadata: Record<string, unknown>,
): { hours: AddonLeadTimeHours | null; legacy: string | null } | null {
  if ("leadTimeHours" in metadata) {
    const hours = metadata.leadTimeHours;
    return hours === null || isAddonLeadTimeHours(hours) ? { hours, legacy: null } : null;
  }
  const text = metadata.leadTime;
  if (text === undefined || text === null) return { hours: null, legacy: null };
  if (typeof text !== "string") return null;
  return { hours: null, legacy: text.trim() ? text : null };
}

/** Whether a guest arriving on `checkIn` gives the add-on's notice: the arrival day at the hotel's
 * check-in time is at least `hours` away (the VAY-2145 bank-transfer rule). */
export function addonLeadTimeAllows(input: {
  hours: AddonLeadTimeHours;
  checkIn: string;
  place: PricingCheckInPlace;
  now: Date;
}): boolean {
  return checkInLeadAllows(input);
}

/** The first property-local arrival date a guest can add the add-on for, or null if unknown. */
export function addonLeadTimeEarliestArrival(input: {
  hours: AddonLeadTimeHours;
  place: PricingCheckInPlace;
  now: Date;
}): string | null {
  return checkInLeadEarliestArrival(input.place, input.now, (checkIn) =>
    addonLeadTimeAllows({ ...input, checkIn }),
  );
}
