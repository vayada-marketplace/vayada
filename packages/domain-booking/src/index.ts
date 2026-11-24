import {
  PMS_RESERVATION_CONTRACT_VERSION,
  type CreatePmsReservationCommand,
  type PmsAuditContext,
  type PmsExternalReference,
  type PmsGuest,
  type PmsInventoryReservationReceipt,
  type PmsMoney,
  type PmsProviderKey,
  type PmsReservationError,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
} from "@vayada/domain-pms";

export {
  parseFlexibleCancellationTerms as parseBookingFlexibleCancellationTerms,
  type FlexibleCancellationTerms as BookingFlexibleCancellationTerms,
} from "@vayada/domain-pms";

export * from "./onboardingPublication.js";
export * from "./defaultGuestTerms.js";
export * from "./firstRunDefaults.js";
export * from "./firstRunBuilders.js";
export * from "./bookingLaunchEvidence.js";
export * from "./bookingLaunchReadiness.js";
export * from "./bookingDesign.js";
export * from "./bookingDesignColors.js";
export * from "./bookingDesignSnapshot.js";
export * from "./bookingDesignReadiness.js";
export * from "./bookingPricingEvidence.js";
export * from "./bookingMandatoryChargeConfirmationEvidenceAdapter.js";
export * from "./bookingPriceCalculation.js";
export * from "./bookingPriceSnapshotInput.js";
export * from "./bookingGuestPolicy.js";
export * from "./bookingGuestPolicyComposer.js";
export * from "./bookingGuestPolicyAggregate.js";
export * from "./bookingGuestPolicyCurrentOwnerEvidence.js";
export * from "./bookingGuestPolicyReadiness.js";
export * from "./bookingGuestPolicyProjection.js";
export * from "./manualBookingPaymentIntent.js";
export * from "./bookingAttribution.js";
export * from "./bookingCustomDomainLock.js";
export * from "./bookingAddonEconomics.js";
export * from "./sameDayBookingPolicy.js";
export * from "./bookedCancellationOutcome.js";
export * from "./roomSelection.js";

export type BookingUtcDateTime = string;
export type BookingDate = string;
export type BookingMoney = PmsMoney;

// ─── Dashboard metrics read model ────────────────────────────────────────────
// Owner: Booking/checkout read model.
// These types represent the target contract for Booking dashboard data so that
// TypeScript Booking code never opens PMS_DATABASE_URL directly (C04 in the
// booking-pms-coupling-audit).

/**
 * Direct bookings (booking page and the hotel's own, from the PMS) made in the period, dated by the
 * day the guest booked in the property's time zone (VAY-2594). Bookings from booking sites are in
 * the source mix only.
 */
export type BookingRevenueStats = {
  totalRevenue: BookingMoney;
  bookingCount: number;
  /**
   * The conversion rate's two sides: bookings made on the booking page ÷ its page views. Both count
   * only the days since the booking page counts every page view (VAY-2592); before that, page views
   * were only visits of guests who allowed analytics. Both are 0 before that day.
   */
  conversionBookingCount?: number;
  conversionPageViewCount?: number;
  /** Bookings excluded from monetary metrics because their amounts are unverified. */
  unverifiedBookingCount?: number;
  /** Bookings excluded from monetary metrics because they are in another currency than the property's (VAY-2390). */
  otherCurrencyBookingCount?: number;
  avgNightlyRate: BookingMoney;
  pageViewCount: number;
};

export type BookingSourceMixItem = {
  /** Booking channel, e.g. "direct", "airbnb", "booking.com" */
  source: string;
  revenue: BookingMoney;
  bookingCount: number;
  /** Bookings excluded from monetary metrics because their amounts are unverified. */
  unverifiedBookingCount?: number;
  /** Bookings excluded from monetary metrics because they are in another currency than the property's (VAY-2390). */
  otherCurrencyBookingCount?: number;
  /** Revenue share as 0–100, rounded to one decimal place */
  revenueSharePercent: number;
};

/** Every channel's bookings made in the period, by booking date (VAY-2594). */
export type BookingSourceMixReadModel = {
  propertyId: string;
  periodStart: BookingDate;
  periodEnd: BookingDate;
  totalRevenue: BookingMoney;
  items: readonly BookingSourceMixItem[];
};

/** Direct bookings by booking date, as in BookingRevenueStats. */
export type BookingSparklinePoint = {
  /** Start of the bucket (inclusive) */
  bucketStart: BookingDate;
  /** End of the bucket (inclusive) */
  bucketEnd: BookingDate;
  revenue: BookingMoney;
  bookingCount: number;
  /** Bookings excluded from monetary metrics because their amounts are unverified. */
  unverifiedBookingCount?: number;
  /** Bookings excluded from monetary metrics because they are in another currency than the property's (VAY-2390). */
  otherCurrencyBookingCount?: number;
  avgNightlyRate: BookingMoney;
  pageViewCount: number;
};

export type BookingSparklineReadModel = {
  propertyId: string;
  /** One bucket per day for windows up to 31 days; longer windows use 31 contiguous buckets. */
  points: readonly BookingSparklinePoint[];
};

export type BookingPageViewBucket = {
  /** Property-local calendar date. */
  date: BookingDate;
  count: number;
};

export type BookingPageViewTimelineReadModel = {
  propertyId: string;
  timeZone: string;
  windowStart: BookingDate;
  windowEnd: BookingDate;
  previousWindowStart: BookingDate;
  previousWindowEnd: BookingDate;
  buckets: readonly BookingPageViewBucket[];
  previousBuckets: readonly BookingPageViewBucket[];
  total: number;
  previousTotal: number;
};

export type BookingDashboardMetricsReadModel = {
  propertyId: string;
  current: BookingRevenueStats;
  previous: BookingRevenueStats;
  /**
   * Next confirmed check-in date for this property, or null if none upcoming.
   * Served from the Booking confirmed-bookings read model; does NOT require
   * an operational PMS reservation query.
   */
  nextArrivalDate: BookingDate | null;
  /**
   * Date of the first confirmed booking ever recorded for this property,
   * or null if no bookings yet.
   */
  liveSinceDate: BookingDate | null;
};

/** Bookings made in the period and the period before, for one channel or direct source. */
export type BookingChannelCount = {
  /** guest_bookings.booking_channel, or direct_booking_source for direct bookings. */
  key: string;
  bookingCount: number;
  previousBookingCount: number;
};

/**
 * Bookings by channel (VAY-2594): every channel's confirmed bookings, by booking date, and the
 * direct ones by where the guest came from. Only keys with bookings in either period are listed.
 */
export type BookingChannelMixReadModel = {
  propertyId: string;
  channels: readonly BookingChannelCount[];
  directSources: readonly BookingChannelCount[];
};

/**
 * Page view tracking check (VAY-2594): over the last 7 days, bookings made on the booking page
 * and its page views. Bookings without a single page view mean the views aren't being counted.
 */
export type BookingTrackingCheckReadModel = {
  propertyId: string;
  /** Booking page bookings guests finished (not drafts or expired ones) in the last 7 days. */
  bookingPageBookingCount: number;
  /** Page views of guests in the last 7 days, consented or not. */
  pageViewCount: number;
  /** At least two such bookings and not one page view: the views aren't arriving. */
  trackingMissing: boolean;
};

/**
 * Guest insights (VAY-2594): the guests of every channel's bookings made in the period, one per
 * booking (its primary guest), by nationality, age at arrival and length of stay.
 */
export type BookingGuestInsightsReadModel = {
  propertyId: string;
  guestCount: number;
  /** Largest first; a null country when the guest gave none. */
  nationalities: readonly { countryCode: string | null; guestCount: number }[];
  /** Ages at arrival, from a date of birth on the guest's profile or check-in. */
  ages: readonly { bucket: "18-24" | "25-34" | "35-44" | "45-54" | "55+"; guestCount: number }[];
  /** Guests whose age is known: the base of the ages. */
  ageKnownCount: number;
  stays: readonly { bucket: "1-2" | "3-4" | "5-7" | "8+"; guestCount: number }[];
  averageNights: number | null;
  /** Days from booking to arrival. */
  averageLeadDays: number | null;
};

/** One day of the revenue chart: direct bookings made that day (VAY-2594). */
export type BookingRevenueDay = {
  /** Property-local calendar date the bookings were made. */
  date: BookingDate;
  revenue: BookingMoney;
  bookingCount: number;
  /** Of those, the bookings made on the booking page (the conversion rate's). */
  bookingPageBookingCount: number;
  /** Bookings in another currency than the property's: counted, but not in revenue. */
  otherCurrencyBookingCount: number;
};

export type BookingRevenueDaysReadModel = {
  propertyId: string;
  windowStart: BookingDate;
  windowEnd: BookingDate;
  /** One entry per day of the window, days without bookings included. */
  days: readonly BookingRevenueDay[];
};

/** A direct booking made on the day the dashboard's day window shows (VAY-2594). */
export type BookingDayBooking = {
  /** The booking's id, which PMS opens it by. */
  id: string;
  reference: string;
  checkIn: BookingDate;
  checkOut: BookingDate;
  nights: number;
  roomCount: number;
  /** The booked room types' names, in room order (empty when unknown). */
  roomNames: readonly string[];
  /** The booking's total in its own currency. */
  total: BookingMoney;
  /** False for a booking in another currency, which the day's revenue leaves out. */
  countedInRevenue: boolean;
};

/** A booking in the Details window's lists, with the day it was made and its state. */
export type BookingDashboardBooking = BookingDayBooking & {
  bookedOn: BookingDate;
  status: "confirmed" | "canceled";
};

/**
 * The Details window (VAY-2594): direct bookings made in the period and the period before, by
 * room type (revenue) and lead time (bookings), with the period's cancellations, its five largest
 * bookings and its five latest ones (cancelled ones included).
 */
export type BookingDashboardDetailsReadModel = {
  propertyId: string;
  /** First day every booking page view is counted (VAY-2592), or null before any. */
  pageViewsCountedFrom: BookingDate | null;
  /** Revenue by the first room's type; null name when it isn't known. */
  roomTypes: readonly {
    name: string | null;
    revenue: BookingMoney;
    previousRevenue: BookingMoney;
  }[];
  /** Days from booking to arrival: 0–7, 8–30, 31–90 and 90+ days. */
  leadTimes: readonly {
    bucket: "0-7" | "8-30" | "31-90" | "90+";
    bookingCount: number;
    previousBookingCount: number;
  }[];
  canceledBookingCount: number;
  topBookings: readonly BookingDashboardBooking[];
  recentBookings: readonly BookingDashboardBooking[];
};

export type BookingDayBookingsReadModel = {
  propertyId: string;
  date: BookingDate;
  revenue: BookingMoney;
  bookingCount: number;
  /** Nights times rooms, over every booking of the day. */
  roomNights: number;
  bookings: readonly BookingDayBooking[];
};

export type BookingDashboardMetricsPeriodInput = {
  propertyId: string;
  periodStart: BookingDate;
  periodEnd: BookingDate;
  previousPeriodStart: BookingDate;
  previousPeriodEnd: BookingDate;
};

/**
 * Read port for Booking dashboard metrics.
 * Implemented by the Booking domain; consumed by Booking API dashboard routes.
 * Must never open PMS_DATABASE_URL — see engineering/booking-pms-coupling-audit.md C04.
 */
export type BookingDashboardMetricsReadPort =
  import("./conversionFunnel.js").BookingConversionFunnelReadPort & {
    getDashboardMetrics(
      input: BookingDashboardMetricsPeriodInput,
    ): Promise<BookingDashboardMetricsReadModel | null>;
    getSourceMix(
      input: Omit<BookingDashboardMetricsPeriodInput, "previousPeriodStart" | "previousPeriodEnd">,
    ): Promise<BookingSourceMixReadModel>;
    getSparklines(input: {
      propertyId: string;
      windowStart: BookingDate;
      windowEnd: BookingDate;
    }): Promise<BookingSparklineReadModel>;
    getPageViewTimeline(input: {
      propertyId: string;
      windowStart: BookingDate;
      windowEnd: BookingDate;
    }): Promise<BookingPageViewTimelineReadModel | null>;
    getChannelMix(input: BookingDashboardMetricsPeriodInput): Promise<BookingChannelMixReadModel>;
    getTrackingCheck(input: { propertyId: string }): Promise<BookingTrackingCheckReadModel>;
    getGuestInsights(input: {
      propertyId: string;
      periodStart: BookingDate;
      periodEnd: BookingDate;
    }): Promise<BookingGuestInsightsReadModel>;
    getDashboardDetails(
      input: BookingDashboardMetricsPeriodInput,
    ): Promise<BookingDashboardDetailsReadModel>;
    getRevenueDays(input: {
      propertyId: string;
      windowStart: BookingDate;
      windowEnd: BookingDate;
    }): Promise<BookingRevenueDaysReadModel | null>;
    getDayBookings(input: {
      propertyId: string;
      date: BookingDate;
    }): Promise<BookingDayBookingsReadModel | null>;
  };

// ─── Booking reservations read model ────────────────────────────────────────
// Owner: Booking/checkout read model. The HTTP route may keep legacy response
// keys for Booking Admin, but this port is the product-domain read boundary.

export type BookingAssignedRoom = {
  roomId: string | null;
  roomNumber: string | null;
  position: number;
};

export type BookingReservationReadModel = {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  roomLines?: Array<{ roomTypeId: string; roomName: string; roomCount: number }>;
  roomMaxOccupancy: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string;
  specialRequests: string;
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  checkIn: BookingDate;
  checkOut: BookingDate;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number | null;
  numberOfRooms: number;
  totalRoomCapacity: number;
  amountStatus?: "recorded" | "unverified";
  totalAmount: number | null;
  currency: string;
  status: string;
  roomId: string | null;
  roomNumber: string | null;
  assignedRooms: BookingAssignedRoom[];
  channel: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number | null;
  checkInPendingFlags: string[];
  checkedInAt: BookingUtcDateTime | null;
  checkedOutAt: BookingUtcDateTime | null;
  hostResponseDeadline: BookingUtcDateTime | null;
  platformFeeAmount: number | null;
  propertyPayoutAmount: number | null;
  addonIds: string[];
  addonNames: string[];
  addonTotal: number;
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
  guestWithdrawn: boolean;
  promoCode: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  createdAt: BookingUtcDateTime;
  updatedAt: BookingUtcDateTime;
};

export type BookingReservationListResult = {
  reservations: BookingReservationReadModel[];
  total: number;
};

export type BookingReservationListFilters = {
  status?: string;
  search?: string;
  canReadGuestContact: boolean;
  limit: number;
  offset: number;
};

export type BookingReservationsReadRepository = {
  resolveCanonicalPropertyId(hotelId: string): Promise<string | null>;
  listReservationsByPropertyId(
    propertyId: string,
    filters: BookingReservationListFilters,
  ): Promise<BookingReservationListResult>;
  close?(): Promise<void>;
};

export type BookingPrimaryGuest = PmsGuest;

export type BookingGuestPiiRole = "booker" | "primary_guest" | "additional_guest";

export type BookingGuestPii = {
  guestId: string;
  guestBookingId: string;
  role: BookingGuestPiiRole;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  countryCodeRaw: string | null;
  countryCodeReviewRequired: boolean;
  arrivalTime: string | null;
  specialRequests: string | null;
};

export type BookingGuestPiiProjection = {
  propertyId: string;
  guestBookingId: string;
  primaryGuest: BookingGuestPii | null;
  additionalGuests: readonly BookingGuestPii[];
};

export type BookingGuestPiiCommandMeta = {
  contractVersion: "booking-guest-pii.v1";
  commandId: string;
  idempotencyKey: string;
  acceptedAt: BookingUtcDateTime;
  sideEffects: readonly ["audit_event"];
};

export type BookingGuestPiiAuditContext = {
  actorUserId: string;
  actorOrganizationId: string;
  requestId: string;
  correlationId?: string;
  source: "pms_operations";
  reason: string;
};

export type BookingAdditionalGuestInput = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  arrivalTime?: string | null;
  specialRequests?: string | null;
};

export type BookingAdditionalGuestCreateCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  guest: BookingAdditionalGuestInput;
  audit: BookingGuestPiiAuditContext;
};

export type BookingAdditionalGuestUpdateCommand = Omit<
  BookingAdditionalGuestCreateCommand,
  "guest"
> & {
  guestId: string;
  guest: Partial<BookingAdditionalGuestInput>;
};

export type BookingAdditionalGuestDeleteCommand = Omit<
  BookingAdditionalGuestCreateCommand,
  "guest"
> & {
  guestId: string;
};

export type BookingPrimaryGuestNationalityCorrectionCommand = Omit<
  BookingAdditionalGuestCreateCommand,
  "guest"
> & {
  countryCode: string;
};

export type BookingGuestPiiCommandResult =
  | {
      ok: true;
      additionalGuest: BookingGuestPii;
      projection: BookingGuestPiiProjection;
      commandMeta: BookingGuestPiiCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409;
      code:
        | "invalid_guest_pii"
        | "reservation_not_found"
        | "primary_guest_not_found"
        | "additional_guest_not_found"
        | "idempotency_conflict";
      message: string;
    };

export type BookingGuestPiiDeleteResult =
  | {
      ok: true;
      guestId: string;
      projection: BookingGuestPiiProjection;
      commandMeta: BookingGuestPiiCommandMeta;
      replayed?: boolean;
    }
  | Exclude<BookingGuestPiiCommandResult, { ok: true }>;

export type BookingPrimaryGuestNationalityCorrectionResult =
  | {
      ok: true;
      primaryGuest: BookingGuestPii;
      projection: BookingGuestPiiProjection;
      commandMeta: BookingGuestPiiCommandMeta;
      replayed?: boolean;
    }
  | Exclude<BookingGuestPiiCommandResult, { ok: true }>;

/**
 * Booking-owned guest PII port for PMS operations.
 *
 * PMS may request an operational projection, but validation, retention,
 * mutation, and guest-visible audit semantics stay in Booking.
 */
export type BookingGuestPiiPort = {
  listGuestPiiForPmsOperations(input: {
    propertyId: string;
    guestBookingId: string;
    canReadGuestContact: boolean;
  }): Promise<BookingGuestPiiProjection | null>;
  correctPrimaryGuestNationalityForPmsOperations(
    command: BookingPrimaryGuestNationalityCorrectionCommand,
  ): Promise<BookingPrimaryGuestNationalityCorrectionResult>;
  createAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestCreateCommand,
  ): Promise<BookingGuestPiiCommandResult>;
  updateAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestUpdateCommand,
  ): Promise<BookingGuestPiiCommandResult>;
  deleteAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestDeleteCommand,
  ): Promise<BookingGuestPiiDeleteResult>;
  close?(): Promise<void>;
};

export type CommittedGuestBooking = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  organizationId: string;
  createdAt: BookingUtcDateTime;
  locale: string;
  stay: {
    checkInDate: BookingDate;
    checkOutDate: BookingDate;
    adults: number;
    children: number;
    numberOfRooms: number;
    estimatedArrivalTime?: string | null;
    specialRequests?: string | null;
  };
  guests: {
    primary: BookingPrimaryGuest;
    additional?: BookingPrimaryGuest[];
  };
  bookedOffer: {
    roomTypeId: string;
    ratePlanId?: string | null;
    roomName: string;
    roomTypeExternalRef?: PmsExternalReference;
    ratePlanExternalRef?: PmsExternalReference;
  };
  pricing: {
    roomTotal: BookingMoney;
    taxesAndFees?: BookingMoney;
    discounts?: BookingMoney;
    addonsTotal?: BookingMoney;
    grandTotal: BookingMoney;
  };
  payment: CreatePmsReservationCommand["payment"];
  policy: CreatePmsReservationCommand["policy"];
  inventoryReservation?: PmsInventoryReservationReceipt;
};

export type PmsReservationConnection = {
  provider: PmsProviderKey;
  connectionId: string;
};

export type BookingHandoffActor = Pick<PmsAuditContext, "actorType" | "actorId" | "source">;

export type BookingPmsReservationHandoffInput = {
  booking: CommittedGuestBooking;
  connection: PmsReservationConnection;
  requestId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: BookingUtcDateTime;
  actor?: BookingHandoffActor;
};

export type BookingPmsHandoffStatus =
  | "pending_handoff"
  | "synced"
  | "accepted_async"
  | "duplicate_replayed"
  | "manual_review_required"
  | "retry_pending";

export type BookingPmsHandoffState = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  status: BookingPmsHandoffStatus;
  outcome: PmsReservationHandoffResult["outcome"];
  pmsReservationRef?: string;
  operationalReservationId?: string;
  providerRequestId?: string;
  auditEventId: string;
  retryAfter?: BookingUtcDateTime;
  error?: PmsReservationError;
};

export class BookingPmsHandoffContractError extends Error {
  readonly code = "PMS_HANDOFF_CONTRACT_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "BookingPmsHandoffContractError";
  }
}

export function buildCreatePmsReservationCommand(
  input: BookingPmsReservationHandoffInput,
): CreatePmsReservationCommand {
  const { booking, connection } = input;
  const idempotencyKey = buildCreateReservationIdempotencyKey({
    propertyId: booking.propertyId,
    guestBookingId: booking.guestBookingId,
  });

  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: buildCreateReservationCommandId(idempotencyKey),
    idempotencyKey,
    audit: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      organizationId: booking.organizationId,
      propertyId: booking.propertyId,
      actorType: input.actor?.actorType ?? "guest",
      actorId: input.actor?.actorId,
      source: input.actor?.source ?? "booking_engine",
      occurredAt: input.occurredAt,
    },
    target: {
      propertyId: booking.propertyId,
      provider: connection.provider,
      connectionId: connection.connectionId,
      requiredCapabilities: ["create_reservation"],
    },
    guestBooking: {
      guestBookingId: booking.guestBookingId,
      bookingReference: booking.bookingReference,
      status: "confirmed",
      createdAt: booking.createdAt,
      source: "direct_booking",
      locale: booking.locale,
    },
    inventoryReservation: booking.inventoryReservation,
    stay: booking.stay,
    guests: booking.guests,
    bookedOffer: booking.bookedOffer,
    pricing: booking.pricing,
    payment: booking.payment,
    policy: booking.policy,
  };
}

export async function handOffCommittedBookingToPms(
  sink: Pick<PmsReservationSink, "createReservation">,
  input: BookingPmsReservationHandoffInput,
): Promise<BookingPmsHandoffState> {
  const command = buildCreatePmsReservationCommand(input);
  const result = await sink.createReservation(command);
  assertPmsResultMatchesCommand(command, result);
  return mapPmsHandoffResultToBookingState({
    booking: input.booking,
    result,
  });
}

function mapPmsHandoffResultToBookingState(input: {
  booking: Pick<CommittedGuestBooking, "guestBookingId" | "bookingReference" | "propertyId">;
  result: PmsReservationHandoffResult;
}): BookingPmsHandoffState {
  const { booking, result } = input;
  return {
    guestBookingId: booking.guestBookingId,
    bookingReference: booking.bookingReference,
    propertyId: booking.propertyId,
    commandId: result.commandId,
    idempotencyKey: result.idempotencyKey,
    status: bookingStatusForResult(result),
    outcome: result.outcome,
    pmsReservationRef: result.pmsReservationRef,
    operationalReservationId: result.operationalReservationId,
    providerRequestId: result.providerRequestId,
    auditEventId: result.auditEventId,
    retryAfter: result.retryAfter,
    error: result.outcome === "failed" ? result.error : undefined,
  };
}

export function buildCreateReservationIdempotencyKey(input: {
  propertyId: string;
  guestBookingId: string;
}): string {
  return `pms.reservation.create:property:${input.propertyId}:booking:${input.guestBookingId}:v1`;
}

function buildCreateReservationCommandId(idempotencyKey: string): string {
  return `cmd_pms_create_${stableHash(idempotencyKey).slice(0, 24)}`;
}

function stableHash(value: string): string {
  const seeds = [0x811c9dc5, 0x811c9dc5 ^ 0x9e3779b9, 0x811c9dc5 ^ 0x85ebca6b];

  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
}

function bookingStatusForResult(result: PmsReservationHandoffResult): BookingPmsHandoffStatus {
  switch (result.outcome) {
    case "succeeded":
      return "synced";
    case "accepted":
      return "accepted_async";
    case "duplicate_replayed":
      return "duplicate_replayed";
    case "noop":
      return "synced";
    case "failed":
      return isRetryableFailure(result.error) ? "retry_pending" : "manual_review_required";
  }
}

function assertPmsResultMatchesCommand(
  command: CreatePmsReservationCommand,
  result: PmsReservationHandoffResult,
): void {
  const mismatches: string[] = [];
  if (result.contractVersion !== command.contractVersion) {
    mismatches.push("contractVersion");
  }
  if (result.commandId !== command.commandId) {
    mismatches.push("commandId");
  }
  if (result.idempotencyKey !== command.idempotencyKey) {
    mismatches.push("idempotencyKey");
  }
  if (result.guestBookingId !== command.guestBooking.guestBookingId) {
    mismatches.push("guestBookingId");
  }

  if (mismatches.length > 0) {
    throw new BookingPmsHandoffContractError(
      `PMS reservation handoff result did not match command fields: ${mismatches.join(", ")}`,
    );
  }
}

function isRetryableFailure(error: PmsReservationError): boolean {
  if (
    error.code === "PMS_DISCONNECTED" ||
    error.code === "UNSUPPORTED_CAPABILITY" ||
    error.code === "DUPLICATE_RESERVATION" ||
    error.code === "MAPPING_MISSING" ||
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "VALIDATION_FAILED" ||
    error.code === "PROVIDER_REJECTED"
  ) {
    return false;
  }

  return error.retryable;
}

export * from "./conversionFunnel.js";
export * from "./accountBookingPage.js";
export * from "./bookingPromotions.js";

export * from "./roomCombinationSearch.js";

export * from "./replacementPricingEvidence.js";
export * from "./pricingPaymentMethods.js";
export * from "./paymentMethodWindows.js";
export * from "./pricingPaidWhenBooking.js";
export * from "./pricingOfferNames.js";
export * from "./publicPricingSelection.js";

export * from "./storedPricingQuote.js";
