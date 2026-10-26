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
 * the property (the VAY-2280 rule only forbids non-refundable rates there). The same shape the setup screen's
 * first price sends through pricing-v2 (FirstPricingSetup), so server- and owner-made rates look alike.
 */
export const FIRST_RUN_CANCELLATION_TERMS: FlexibleCancellationTerms = Object.freeze({
  type: "free_until_days_before_arrival",
  freeCancellationDeadlineDays: 3,
  afterDeadlinePenalty: "full_booking_amount",
  noShowPenalty: "full_booking_amount",
});

/**
 * VAY-2247 1.12b: the first run's cancellation choices, free cancellation until 1, 3, 7 or 14 days before
 * arrival. Non-refundable isn't one yet: it is paid in advance (VAY-2280), and the first run only sets up
 * paying at the property. It comes with online card payments (VAY-2205).
 */
export const FIRST_RUN_FREE_CANCELLATION_DAYS = Object.freeze([1, 3, 7, 14] as const);
export type FirstRunFreeCancellationDays = (typeof FIRST_RUN_FREE_CANCELLATION_DAYS)[number];
export const FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS: FirstRunFreeCancellationDays = 3;

export function isFirstRunFreeCancellationDays(
  value: unknown,
): value is FirstRunFreeCancellationDays {
  return (FIRST_RUN_FREE_CANCELLATION_DAYS as readonly unknown[]).includes(value);
}

/** The default terms with the chosen number of days; the penalties stay the full stay. */
export function firstRunCancellationTerms(
  days: FirstRunFreeCancellationDays = FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
): FlexibleCancellationTerms {
  return Object.freeze({ ...FIRST_RUN_CANCELLATION_TERMS, freeCancellationDeadlineDays: days });
}

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
 * VAY-2247 1.12b: the first run's bed choices, one bed per room, or two twin beds for a twin room. The
 * owner adds the real beds per room type later; these are keys of the PMS's bed vocabulary.
 */
export const FIRST_RUN_BED_CHOICES = Object.freeze([
  "double",
  "queen",
  "king",
  "twin",
  "single",
] as const);
export type FirstRunBedChoice = (typeof FIRST_RUN_BED_CHOICES)[number];
export const FIRST_RUN_DEFAULT_BED: FirstRunBedChoice = "double";

export function isFirstRunBedChoice(value: unknown): value is FirstRunBedChoice {
  return (FIRST_RUN_BED_CHOICES as readonly unknown[]).includes(value);
}

export function firstRunBeds(
  choice: FirstRunBedChoice = FIRST_RUN_DEFAULT_BED,
): readonly Readonly<{ type: FirstRunBedChoice; quantity: 1 | 2 }>[] {
  return Object.freeze([Object.freeze({ type: choice, quantity: choice === "twin" ? 2 : 1 })]);
}

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
