import type { FlexibleCancellationTerms, PmsOperatingSchedule } from "@vayada/domain-pms";

import {
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  type BookingDesignChoices,
} from "./bookingDesign.js";
import type { BookingGuestLanguage, BookingGuestPolicyChoices } from "./bookingGuestPolicy.js";
import { DEFAULT_GUEST_TERMS } from "./defaultGuestTerms.js";

/**
 * What a hotel starts with when it goes live fast (VAY-2247, approved by Flamur 2026-10-16/19). The server's
 * first run saves these as real data, so "defaults count as ready"; the owner changes any of them later.
 * The hotel's currency is not here: it comes from its country (`defaultCurrencyForCountry` in
 * @vayada/locale-constants), and the guest language from the hotel's own language.
 */
export const FIRST_RUN_DEFAULTS_VERSION = "hotel-first-run-defaults.v1" as const;

/** "Classic": the Grand Classic font pairing in the default booking-page colour. */
export const FIRST_RUN_BOOKING_DESIGN: BookingDesignChoices = Object.freeze({
  primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  fontPairing: "grand-classic",
});

export const FIRST_RUN_CHECK_IN_TIME = "15:00";
export const FIRST_RUN_CHECK_OUT_TIME = "11:00";
/** Children welcome; guests from 12 count as adults. */
export const FIRST_RUN_ADULT_AGE_THRESHOLD = 12;

/** Guest rules: children welcome, phone required, special requests on, 15:00 / 11:00. */
export function firstRunGuestPolicy(language: BookingGuestLanguage): BookingGuestPolicyChoices {
  return Object.freeze({
    defaultGuestLanguage: language,
    childrenEnabled: true,
    adultAgeThreshold: FIRST_RUN_ADULT_AGE_THRESHOLD,
    phoneRequired: true,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: true,
    checkInTime: FIRST_RUN_CHECK_IN_TIME,
    checkOutTime: FIRST_RUN_CHECK_OUT_TIME,
  });
}

/** The booking page shows the city and country (address_public), not the street. */
export const FIRST_RUN_SHOW_CITY_AND_COUNTRY = true;

export const FIRST_RUN_GUEST_TERMS = DEFAULT_GUEST_TERMS;

/**
 * Free cancellation until 3 days before arrival, then the full stay. A refundable rate, so it can be paid at
 * the property (the VAY-2280 rule only forbids non-refundable rates there).
 */
export const FIRST_RUN_CANCELLATION_TERMS: FlexibleCancellationTerms = Object.freeze({
  type: "free_until_days_before_arrival",
  freeCancellationDeadlineDays: 3,
  afterDeadlinePenalty: "full_booking_amount",
  noShowPenalty: "full_booking_amount",
  flexibleCancellationType: "free",
});

/** Open all year with a one-night minimum; future dates keep opening through auto-open (on by default). */
export const FIRST_RUN_OPERATING_SCHEDULE: PmsOperatingSchedule = Object.freeze({
  mode: "year_round",
  periods: Object.freeze([]) as readonly [],
});
export const FIRST_RUN_MINIMUM_STAY_NIGHTS = 1;

/** One double bed per room until the owner adds the real beds. */
export const FIRST_RUN_BEDS: readonly Readonly<{ type: "double"; quantity: 1 }>[] = Object.freeze([
  Object.freeze({ type: "double", quantity: 1 }),
]);

/**
 * Names for a room type's rooms, so the calendar can open them (auto-open needs every unit labelled).
 * Numbering continues across room types: the first type gets Room 1–8, the next one Room 9–12.
 */
export function firstRunRoomLabels(count: number, firstNumber = 1): string[] {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(firstNumber) || firstNumber < 1) {
    throw new RangeError("firstRunRoomLabels needs a positive room count and first number");
  }
  return Array.from({ length: count }, (_, index) => `Room ${firstNumber + index}`);
}
