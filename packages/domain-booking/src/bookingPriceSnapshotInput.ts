import {
  type FinancePaymentMethodsSourceEntityRevision,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import {
  type FlexibleCancellationTerms,
  type NonRefundableCancellationTerms,
  type PmsPricingSourceEntityRevision,
} from "@vayada/domain-pms";

import {
  type BookingPriceCalculation,
  type BookingPriceCalculationInput,
  type BookingPriceMinorUnits,
} from "./bookingPriceCalculation.js";
import {
  type BookingMandatoryChargeConfirmationEvidence,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";

export const BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION =
  "booking-price-snapshot-input.v1" as const;
export const BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL = "explicit_zero.v1" as const;

const SOURCE_KIND_ORDER = Object.freeze([
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const);

export type BookingPriceRecurringSourceBinding = Readonly<{
  sourceKind: (typeof SOURCE_KIND_ORDER)[number];
  source: PmsPricingSourceEntityRevision;
  validationRevision: number;
  materializationRevision: number;
}>;

export type BookingCancellationDisclosure =
  | Readonly<{
      selectedPlan: "flexible";
      source: PmsPricingSourceEntityRevision;
      paymentTiming: null;
      terms: FlexibleCancellationTerms;
    }>
  | Readonly<{
      selectedPlan: "non_refundable";
      source: BookingPriceRecurringSourceBinding;
      paymentTiming: "prepay_full";
      terms: NonRefundableCancellationTerms;
    }>;

export type BookingAdditionalGuestDisclosure =
  | Readonly<{
      kind: "not_applied";
      includedGuestsPerRoom: null;
      chargeableGuestCount: 0;
      totalMinorUnits: BookingPriceMinorUnits;
    }>
  | Readonly<{
      kind: "per_stay_night";
      source: BookingPriceRecurringSourceBinding;
      unitAmountDecimal: string;
      currency: string;
      includedGuestsPerRoom: number;
      chargeableGuestCount: number;
      totalMinorUnits: BookingPriceMinorUnits;
    }>;

export type BookingPriceSnapshotFactoryInput = Readonly<{
  calculationInput: BookingPriceCalculationInput;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidence;
  adultCount: number;
  childCount: number;
}>;

export type BookingPriceSnapshotInput = Readonly<{
  contractVersion: typeof BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  calculation: BookingPriceCalculation;
  pmsSourceBindings: Readonly<{
    pricingCurrency: PmsPricingSourceEntityRevision;
    flexibleRatePlan: PmsPricingSourceEntityRevision;
    optionalPricingAggregate: PmsPricingSourceEntityRevision;
    roomFacts: Readonly<{ roomTypeId: string; roomFactsRevision: number }>;
    recurringSources: readonly BookingPriceRecurringSourceBinding[];
  }>;
  financePaymentEligibility: Readonly<{
    requiredForSelection: boolean;
    source: FinancePaymentMethodsSourceEntityRevision | null;
    snapshot: FinancePaymentReadinessSnapshot | null;
  }>;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidence;
  guestCounts: Readonly<{
    roomCount: number;
    adultCount: number;
    childCount: number;
    includedGuestsPerRoom: number | null;
    chargeableGuestCount: number;
  }>;
  selectedPlan:
    | Readonly<{
        kind: "flexible";
        flexibleRatePlanId: string;
        paymentTiming: null;
      }>
    | Readonly<{
        kind: "non_refundable";
        flexibleRatePlanId: string;
        nonRefundableSourceId: string;
        paymentTiming: "prepay_full";
      }>;
  cancellationDisclosure: BookingCancellationDisclosure;
  additionalGuestDisclosure: BookingAdditionalGuestDisclosure;
  taxesAndFees: Readonly<{
    model: typeof BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL;
    taxTotalMinorUnits: BookingPriceMinorUnits;
    feeTotalMinorUnits: BookingPriceMinorUnits;
    totalMinorUnits: BookingPriceMinorUnits;
  }>;
  totals: Readonly<{
    priceTotalMinorUnits: BookingPriceMinorUnits;
    taxesAndFeesTotalMinorUnits: BookingPriceMinorUnits;
    grandTotalMinorUnits: BookingPriceMinorUnits;
  }>;
}>;

/** Preview and quote consumers use the exact same immutable monetary evidence. */
export type BookingPricePreviewInput = BookingPriceSnapshotInput;
export type BookingPriceQuoteInput = BookingPriceSnapshotInput;

export function createBookingPriceSnapshotInput(
  input: BookingPriceSnapshotFactoryInput,
): BookingPriceSnapshotInput | null {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}
