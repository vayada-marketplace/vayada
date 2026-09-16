import {
  type FinancePaymentMethodsSourceEntityRevision,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import {
  type FlexibleCancellationTerms,
  type NonRefundableCancellationTerms,
  type PmsPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type RoomPublicationSnapshot,
} from "@vayada/domain-pms";

import {
  BOOKING_PRICING_ROUNDING_MODE,
  BOOKING_PRICING_SCALE,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";

export const BOOKING_PRICE_CALCULATION_CONTRACT_VERSION = "booking-price-calculation.v1" as const;
export const BOOKING_PRICE_V1_ALLOCATION_RULE =
  "single_room_type_aggregate_guest_count.v1" as const;
export const BOOKING_PRICE_MAX_MINOR_UNITS = "9223372036854775807" as const;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,18}))?$/;
const MINOR_UNITS_PATTERN = /^(?:0|[1-9][0-9]*)$/;

declare const bookingPriceMinorUnitsBrand: unique symbol;

export type BookingPriceMinorUnits = string & {
  readonly [bookingPriceMinorUnitsBrand]: true;
};

export type BookingPriceCalculationInput = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  roomCount: number;
  chargeableGuestCount: number;
  additionalGuestSourceId: string | null;
  selectedRate:
    | Readonly<{ kind: "flexible" }>
    | Readonly<{ kind: "non_refundable"; sourceId: string }>;
  nights: readonly Readonly<{
    stayDate: string;
    appliedSeasonSourceId: string | null;
    appliedWeekendSurchargeSourceId: string | null;
  }>[];
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
  roomPublication: RoomPublicationSnapshot;
  financePaymentReadiness: FinancePaymentReadinessSnapshot | null;
}>;

export type BookingAppliedSourceRevision = Readonly<{
  sourceId: string;
  sourceRevision: number;
  validationRevision: number;
  materializationRevision: number;
}>;

export type BookingPriceNightBreakdown = Readonly<{
  stayDate: string;
  baseAmount:
    | Readonly<{
        kind: "standard";
        amountDecimal: string;
        flexibleRatePlanId: string;
        flexibleRatePlanRevision: number;
      }>
    | Readonly<{
        kind: "seasonal";
        amountDecimal: string;
        source: BookingAppliedSourceRevision;
      }>;
  baseRoomTotalMinorUnits: BookingPriceMinorUnits;
  weekendSurcharge: Readonly<{
    amountDecimal: string;
    roomTotalMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  additionalGuest: Readonly<{
    amountDecimal: string;
    includedGuestsPerRoom: number;
    chargeableGuestCount: number;
    totalMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  flexibleNightTotalMinorUnits: BookingPriceMinorUnits;
  nonRefundableDiscount: Readonly<{
    discountPercent: number;
    amountMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  finalNightTotalMinorUnits: BookingPriceMinorUnits;
}>;

export type BookingPriceCalculation = Readonly<{
  contractVersion: typeof BOOKING_PRICE_CALCULATION_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  currency: string;
  scale: typeof BOOKING_PRICING_SCALE;
  roundingMode: typeof BOOKING_PRICING_ROUNDING_MODE;
  allocationRule: typeof BOOKING_PRICE_V1_ALLOCATION_RULE;
  roomCount: number;
  includedGuestsPerRoom: number | null;
  chargeableGuestCount: number;
  selectedRate:
    | Readonly<{
        kind: "flexible";
        cancellationTerms: FlexibleCancellationTerms;
      }>
    | Readonly<{
        kind: "non_refundable";
        paymentTiming: "prepay_full";
        cancellationTerms: NonRefundableCancellationTerms;
        source: BookingAppliedSourceRevision;
        financePaymentMethodsSource: FinancePaymentMethodsSourceEntityRevision;
      }>;
  sourceRevisions: Readonly<{
    pricingCurrencyRevision: number;
    roomFactsRevision: number;
    flexibleRatePlanRevision: number;
    optionalPricingAggregateRevision: number;
  }>;
  nights: readonly BookingPriceNightBreakdown[];
  stayTotalMinorUnits: BookingPriceMinorUnits;
}>;

/** Decimal round-half-up at Booking's fixed scale without binary floating point. */
export function roundBookingPriceDecimalToMinorUnits(
  value: unknown,
): BookingPriceMinorUnits | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  let minorUnits = BigInt(match[1]!) * 100n + BigInt(fraction.slice(0, 2));
  if (fraction[2]! >= "5") minorUnits += 1n;
  if (minorUnits > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return null;
  return String(minorUnits) as BookingPriceMinorUnits;
}

export function formatBookingPriceMinorUnits(value: unknown): string | null {
  if (typeof value !== "string" || !MINOR_UNITS_PATTERN.test(value)) return null;
  if (BigInt(value) > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return null;
  const padded = value.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

export function applyBookingPricePercentageDiscount(
  flexibleNightMinorUnits: unknown,
  discountPercent: unknown,
): Readonly<{
  discountMinorUnits: BookingPriceMinorUnits;
  finalMinorUnits: BookingPriceMinorUnits;
}> | null {
  if (
    typeof flexibleNightMinorUnits !== "string" ||
    !MINOR_UNITS_PATTERN.test(flexibleNightMinorUnits) ||
    BigInt(flexibleNightMinorUnits) > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS) ||
    !isIntegerInRange(discountPercent, 1, 50)
  )
    return null;
  const flexible = BigInt(flexibleNightMinorUnits);
  const final = roundRatioHalfUp(flexible * BigInt(100 - discountPercent), 100n);
  return Object.freeze({
    discountMinorUnits: minorUnits(flexible - final),
    finalMinorUnits: minorUnits(final),
  });
}

/** Temporary unavailable boundary; the old nightly resolver was removed in VAY-1546. */
export function createBookingNightlyRoomPriceResolver(input: {
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
  roomTypeId: string;
  flexibleRatePlanId: string;
  roomFactsRevision: number;
}): (
  stayDate: string,
  datePrice?: { amountDecimal: string; currency: string },
) => BookingPriceMinorUnits {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}

/** A percentage with up to four decimal places, rounded once at the currency boundary. */
export function applyBookingPriceMarkup(amount: BookingPriceMinorUnits, percent: number): string {
  if (
    !Number.isFinite(percent) ||
    percent < -50 ||
    percent > 200 ||
    !/^\d+(?:\.\d{1,4})?$/.test(String(Math.abs(percent)))
  )
    throw new TypeError("Invalid channel markup.");
  const [whole, fraction = ""] = String(Math.abs(percent)).split(".");
  const units =
    (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"))) * (percent < 0 ? -1n : 1n);
  return formatBookingPriceMinorUnits(
    minorUnits(roundRatioHalfUp(BigInt(amount) * (1000000n + units), 1000000n)),
  )!;
}

export function calculateBookingPrice(
  input: BookingPriceCalculationInput,
): BookingPriceCalculation {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}

function roundRatioHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return boundedMinorUnits(remainder * 2n >= denominator ? quotient + 1n : quotient);
}

function minorUnits(value: bigint): BookingPriceMinorUnits {
  return String(boundedMinorUnits(value)) as BookingPriceMinorUnits;
}

function boundedMinorUnits(value: bigint): bigint {
  if (value < 0n || value > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return invalidInput();
  return value;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function invalidInput(): never {
  throw new TypeError("Booking price calculation input is invalid");
}
