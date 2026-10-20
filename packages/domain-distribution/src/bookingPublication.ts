import { isDeepStrictEqual } from "node:util";

import type { ProductReadinessHash, SourceManifestHash } from "@vayada/domain-hotels";

import {
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
  PUBLIC_BOOKABILITY_VISIBILITY,
  assertPublicBookabilityPublicSafe,
  publicManualPaymentReady,
  type PublicBookabilityProfileProjection,
} from "./index.js";
import { parsePublicBookabilityProfileProjection } from "./publicBookabilityProfileParser.js";

export const BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION = "booking-public-content.v1" as const;

/**
 * A booking page needs availability prepared from today through at least 334 more days (11
 * months, VAY-2150). Setup prepares a full year and auto-open keeps 12+ months to a month end,
 * so this leaves a month of slack. Launch readiness asks for the same window.
 */
export const BOOKING_PUBLICATION_MIN_OPEN_DAYS = 334;
/** Bank transfer and PayPal are paid to the hotel, which confirms the payment (VAY-2139). */
export type BookingPublicPaymentMethod = "card" | "pay_at_property" | "bank_transfer" | "paypal";
const BOOKING_PUBLIC_PAYMENT_METHODS: readonly string[] = [
  "card",
  "pay_at_property",
  "bank_transfer",
  "paypal",
];
type BookingPublicFinanceEvidence = Readonly<{
  defaultCurrency: string;
  supportedCurrencies: readonly string[];
  onlinePayment: boolean;
  payAtProperty: boolean;
  readyPaymentMethods: readonly BookingPublicPaymentMethod[];
}>;

type LegacyBookingPublicRate = Readonly<{
  ratePlanId: string;
  currency: string;
  baseNightlyAmount: string;
  refundable: boolean;
  cancellation?: string | null;
  paymentTiming: "pay_at_property" | "prepay_full";
}>;

/** Offer identity only. Amounts, eligibility and payment terms require a stay quote. */
export type BookingPublicQuotedOffer = Readonly<{
  ratePlanId: string;
  currency: string;
  pricing: Readonly<{ kind: "quote_required"; publicationRevision: number; termsRevision: string }>;
  mealPlan: "room_only" | "breakfast" | "half_board" | "full_board" | "all_inclusive";
}>;
export type BookingPublicRate = LegacyBookingPublicRate | BookingPublicQuotedOffer;

export type BookingPublicRoom = Readonly<{
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancy: Readonly<{ maxGuests: number; maxAdults: number; maxChildren: number }>;
  beds: readonly Readonly<{ type: string; quantity: number }>[];
  bedrooms: number | null;
  bathrooms: number | null;
  bathroomType: "private" | "shared";
  size: Readonly<{ value: number; unit: "sqm" }> | null;
  images: readonly { url: string; alt?: string | null }[];
  amenities: readonly string[];
  rates: readonly BookingPublicRate[];
}>;

export type BookingPublicCalendarSnapshot = Readonly<{
  sourceRevision: string;
  materializedRevision: string;
  currentLocalDate: string;
  coverageFrom: string;
  coverageThrough: string;
  materializedThrough: string;
  expectedDayCount: number;
  materializedDayCount: number;
  gapCount: number;
  roomTypeIds: readonly string[];
  observedAt: string;
}>;

export type BookingPublicContent = Readonly<{
  contractVersion: typeof BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION;
  profile: PublicBookabilityProfileProjection;
  rooms: readonly BookingPublicRoom[];
  calendar: BookingPublicCalendarSnapshot;
  payments: Readonly<{ readyMethods: readonly BookingPublicPaymentMethod[] }>;
}>;

export type BookingPublicContentBuild = Readonly<{
  sourceManifestHash: SourceManifestHash;
  readinessHash: ProductReadinessHash;
  publicContent: BookingPublicContent;
}>;

type BookingPublicContentInput = {
  sourceManifestHash: SourceManifestHash;
  readinessHash: ProductReadinessHash;
  profile: PublicBookabilityProfileProjection;
  rooms: readonly BookingPublicRoom[];
  calendar: BookingPublicCalendarSnapshot;
  finance: BookingPublicFinanceEvidence;
};

/** Which part of the content was refused, for logs (VAY-2292). */
export type BookingPublicContentRejection =
  | "hashes"
  | "profile"
  | "rooms"
  | "calendar"
  | "profile_state"
  | "payments";

export function buildBookingPublicContent(
  input: BookingPublicContentInput,
): BookingPublicContentBuild | null {
  const result = tryBuildBookingPublicContent(input);
  return "rejected" in result ? null : result.build;
}

export function tryBuildBookingPublicContent(
  input: BookingPublicContentInput,
): { build: BookingPublicContentBuild } | { rejected: BookingPublicContentRejection } {
  if (!validHash(input.sourceManifestHash) || !validHash(input.readinessHash))
    return { rejected: "hashes" };
  const readyMethods = [...new Set(input.finance.readyPaymentMethods)]
    .filter((method) => BOOKING_PUBLIC_PAYMENT_METHODS.includes(method))
    .sort();
  const profile = parsePublicBookabilityProfileProjection(input.profile, {
    manualPaymentReady: publicManualPaymentReady(readyMethods),
  });
  if (!profile) return { rejected: "profile" };
  const rooms = sanitizeRooms(input.rooms, input.finance, readyMethods);
  if (!rooms) return { rejected: "rooms" };
  const calendar = sanitizeCalendar(input.calendar, rooms, profile);
  if (!calendar) return { rejected: "calendar" };
  if (!validProfile(profile, input.finance)) return { rejected: "profile_state" };
  if (
    readyMethods.includes("card") !== input.finance.onlinePayment ||
    readyMethods.includes("pay_at_property") !== input.finance.payAtProperty
  )
    return { rejected: "payments" };

  const publicContent = deepFreeze({
    contractVersion: BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION,
    profile: structuredClone(profile),
    rooms,
    calendar,
    payments: { readyMethods },
  });
  assertPublicBookabilityPublicSafe(publicContent);
  return {
    build: deepFreeze({
      sourceManifestHash: input.sourceManifestHash,
      readinessHash: input.readinessHash,
      publicContent,
    }),
  };
}

/** Parses stored immutable JSON into the exact public Booking content contract. Content
 * published with bank transfer or PayPal counts only while their acceptance is on
 * (`manualPayments`), so turning it off takes such pages down again (VAY-2139). */
export function parseBookingPublicContent(
  value: unknown,
  context: { manualPayments?: boolean } = {},
): BookingPublicContent | null {
  try {
    if (!record(value) || !Array.isArray(value.rooms) || !record(value.calendar)) return null;
    const payments = record(value.payments) ? value.payments.readyMethods : null;
    if (!Array.isArray(payments)) return null;
    const manualPaymentReady = publicManualPaymentReady(payments);
    if (manualPaymentReady && context.manualPayments !== true) return null;
    const profile = parsePublicBookabilityProfileProjection(value.profile, { manualPaymentReady });
    if (!profile) return null;
    const built = buildBookingPublicContent({
      sourceManifestHash: `sha256:${"0".repeat(64)}`,
      readinessHash: `sha256:${"0".repeat(64)}`,
      profile,
      rooms: value.rooms as BookingPublicRoom[],
      calendar: value.calendar as BookingPublicCalendarSnapshot,
      finance: {
        defaultCurrency: profile.hotel.defaultCurrency,
        supportedCurrencies: profile.hotel.supportedCurrencies,
        onlinePayment: profile.hotel.capabilities.onlinePayment,
        payAtProperty: profile.hotel.capabilities.payAtProperty,
        readyPaymentMethods: payments as BookingPublicPaymentMethod[],
      },
    });
    return built && isDeepStrictEqual(built.publicContent, value) ? built.publicContent : null;
  } catch {
    return null;
  }
}

function validProfile(
  profile: PublicBookabilityProfileProjection,
  finance: BookingPublicFinanceEvidence,
): boolean {
  const generated = Date.parse(profile.generatedAt);
  const sources = profile.freshness.sources;
  const { hotel } = profile;
  return (
    profile.contractVersion === PUBLIC_BOOKABILITY_CONTRACT_VERSION &&
    profile.publicVisibility === PUBLIC_BOOKABILITY_VISIBILITY &&
    [hotel.propertyId, hotel.slug, hotel.name, hotel.timezone].every(nonEmpty) &&
    hotel.trust.profileComplete &&
    hotel.trust.profileVerified &&
    hotel.trust.bookabilityStatus === "bookable" &&
    hotel.trust.reasonCodes.length === 0 &&
    profile.freshness.status === "fresh" &&
    profile.freshness.generatedAt === profile.generatedAt &&
    sameOwners(profile.dataSources, PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS) &&
    sameOwners(
      sources.map(({ owner }) => owner),
      PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
    ) &&
    sources.every(
      ({ status, lastUpdatedAt }) =>
        status === "fresh" && validInstant(lastUpdatedAt) && Date.parse(lastUpdatedAt) <= generated,
    ) &&
    hotel.capabilities.onlinePayment === finance.onlinePayment &&
    hotel.capabilities.payAtProperty === finance.payAtProperty &&
    hotel.defaultCurrency === finance.defaultCurrency &&
    sameOwners(hotel.supportedCurrencies, finance.supportedCurrencies) &&
    sameOwners(hotel.supportedQuoteParameters.supportedCurrencies, finance.supportedCurrencies)
  );
}

function sameOwners(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    [...left].sort().join("\0") === [...right].sort().join("\0")
  );
}

function sanitizeRooms(
  input: readonly BookingPublicRoom[],
  finance: BookingPublicFinanceEvidence,
  readyMethods: readonly string[],
): readonly BookingPublicRoom[] | null {
  const roomIds = new Set<string>();
  const rooms = input.map((value) => {
    const room = cleanRoomFacts(value);
    if (!validRoomFacts(room) || roomIds.has(room.roomTypeId)) return null;
    roomIds.add(room.roomTypeId);
    const rateIds = new Set<string>();
    const rates = room.rates.flatMap<BookingPublicRate | null>((rate) => {
      if (
        !validRateFacts(rate) ||
        rateIds.has(rate.ratePlanId) ||
        rate.currency !== finance.defaultCurrency ||
        !finance.supportedCurrencies.includes(rate.currency)
      )
        return [null];
      if ("pricing" in rate) {
        if (!readyMethods.length) return [];
        rateIds.add(rate.ratePlanId);
        return [
          {
            ratePlanId: rate.ratePlanId,
            currency: rate.currency,
            pricing: {
              kind: "quote_required" as const,
              publicationRevision: rate.pricing.publicationRevision,
              termsRevision: rate.pricing.termsRevision,
            },
            mealPlan: rate.mealPlan,
          },
        ];
      }
      const method = rate.paymentTiming === "prepay_full" ? "card" : "pay_at_property";
      if (!readyMethods.includes(method)) return [];
      rateIds.add(rate.ratePlanId);
      return [
        {
          ratePlanId: rate.ratePlanId,
          currency: rate.currency,
          baseNightlyAmount: rate.baseNightlyAmount,
          refundable: rate.refundable,
          ...(rate.cancellation === undefined ? {} : { cancellation: rate.cancellation }),
          paymentTiming: rate.paymentTiming,
        },
      ];
    });
    if (rates.length === 0 || rates.some((rate) => !rate)) return null;
    return {
      roomTypeId: room.roomTypeId,
      name: room.name,
      description: room.description,
      category: room.category,
      occupancy: { ...room.occupancy },
      beds: room.beds.map((bed) => ({ ...bed })),
      bedrooms: room.bedrooms,
      bathrooms: room.bathrooms,
      bathroomType: room.bathroomType,
      size: room.size && { ...room.size },
      images: room.images.map(({ url, alt }) => ({ url, ...(alt === undefined ? {} : { alt }) })),
      amenities: [...room.amenities],
      rates: rates as BookingPublicRate[],
    };
  });
  return rooms.length > 0 && !rooms.some((room) => !room) ? (rooms as BookingPublicRoom[]) : null;
}

/** Room details the page can't show are left off rather than failing it: a bathroom count other
 * than whole or half numbers, a photo used twice and blank photo text (VAY-2292). */
function cleanRoomFacts(room: BookingPublicRoom): BookingPublicRoom {
  if (!record(room) || !Array.isArray(room.images)) return room;
  const urls = new Set<unknown>();
  return {
    ...room,
    bathrooms:
      room.bathroomType === "private" && bathroomCount(room.bathrooms) ? room.bathrooms : null,
    images: room.images.flatMap((image) => {
      if (!record(image) || urls.has(image.url)) return [];
      urls.add(image.url);
      const alt = typeof image.alt === "string" ? image.alt.trim() || null : image.alt;
      return [{ url: image.url, ...(alt === undefined ? {} : { alt }) }];
    }),
  };
}

function validRoomFacts(room: BookingPublicRoom): boolean {
  if (
    !record(room) ||
    !record(room.occupancy) ||
    !Array.isArray(room.beds) ||
    !Array.isArray(room.images) ||
    !Array.isArray(room.amenities) ||
    !Array.isArray(room.rates)
  )
    return false;
  const { maxGuests, maxAdults, maxChildren } = room.occupancy;
  return (
    [room.roomTypeId, room.name].every(nonEmpty) &&
    typeof room.description === "string" &&
    room.description.length <= 5_000 &&
    !room.description.includes("\0") &&
    (room.category === null || nonEmpty(room.category)) &&
    integer(maxGuests, 1) &&
    integer(maxAdults, 1, maxGuests) &&
    integer(maxChildren, 0, maxGuests) &&
    maxAdults + maxChildren >= maxGuests &&
    room.beds.length > 0 &&
    new Set(room.beds.map(({ type }) => type)).size === room.beds.length &&
    room.beds.every(({ type, quantity }) => nonEmpty(type) && integer(quantity, 1)) &&
    (room.bedrooms === null || (Number.isInteger(room.bedrooms) && room.bedrooms >= 0)) &&
    (room.bathrooms === null || bathroomCount(room.bathrooms)) &&
    (room.bathroomType === "private" ||
      (room.bathroomType === "shared" && room.bathrooms === null)) &&
    (room.size === null ||
      (record(room.size) &&
        typeof room.size.value === "number" &&
        Number.isFinite(room.size.value) &&
        room.size.value > 0 &&
        room.size.unit === "sqm")) &&
    room.images.length > 0 &&
    new Set(room.images.map(({ url }) => url)).size === room.images.length &&
    room.images.every(
      (image) =>
        record(image) &&
        validHttpsUrl(image.url) &&
        (image.alt === undefined || image.alt === null || nonEmpty(image.alt)),
    ) &&
    new Set(room.amenities).size === room.amenities.length &&
    room.amenities.every(nonEmpty)
  );
}

function validRateFacts(rate: BookingPublicRate): boolean {
  if (record(rate) && "pricing" in rate) {
    const pricing = rate.pricing;
    return (
      Object.keys(rate).sort().join(",") === "currency,mealPlan,pricing,ratePlanId" &&
      /^pricing-offer\.v2:[a-f0-9]{64}$/.test(rate.ratePlanId) &&
      record(pricing) &&
      Object.keys(pricing).sort().join(",") === "kind,publicationRevision,termsRevision" &&
      pricing.kind === "quote_required" &&
      Number.isSafeInteger(pricing.publicationRevision) &&
      pricing.publicationRevision > 0 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        pricing.termsRevision,
      ) &&
      ["room_only", "breakfast", "half_board", "full_board", "all_inclusive"].includes(
        rate.mealPlan,
      )
    );
  }
  return (
    record(rate) &&
    nonEmpty(rate.ratePlanId) &&
    !rate.ratePlanId.startsWith("pricing-offer.v2:") &&
    /^\d+\.\d{2}$/.test(rate.baseNightlyAmount) &&
    Number(rate.baseNightlyAmount) >= 0 &&
    typeof rate.refundable === "boolean" &&
    (rate.paymentTiming === "prepay_full" || rate.paymentTiming === "pay_at_property") &&
    (rate.cancellation === undefined || rate.cancellation === null || nonEmpty(rate.cancellation))
  );
}

function sanitizeCalendar(
  value: BookingPublicCalendarSnapshot,
  rooms: readonly BookingPublicRoom[] | null,
  profile: PublicBookabilityProfileProjection,
): BookingPublicCalendarSnapshot | null {
  if (!rooms) return null;
  const { generatedAt } = profile;
  const roomTypeIds = [...new Set(value.roomTypeIds)].sort();
  const expectedRooms = rooms.map(({ roomTypeId }) => roomTypeId).sort();
  // Coverage may have started before today (prepared yesterday) and may run past a year
  // (auto-open to a month end); it must cover today and the next 11 months.
  const coveredDays = inclusiveDays(value.coverageFrom, value.coverageThrough);
  if (
    !validInstant(generatedAt) ||
    value.currentLocalDate !== localDateAt(generatedAt, profile.hotel.timezone) ||
    !nonEmpty(value.sourceRevision) ||
    value.sourceRevision !== value.materializedRevision ||
    coveredDays < 1 ||
    value.coverageFrom > value.currentLocalDate ||
    inclusiveDays(value.currentLocalDate, value.coverageThrough) <
      BOOKING_PUBLICATION_MIN_OPEN_DAYS + 1 ||
    value.coverageThrough !== value.materializedThrough ||
    value.expectedDayCount !== coveredDays * rooms.length ||
    value.materializedDayCount !== coveredDays * rooms.length ||
    value.gapCount !== 0 ||
    JSON.stringify(roomTypeIds) !== JSON.stringify(expectedRooms) ||
    !validInstant(value.observedAt) ||
    Date.parse(value.observedAt) > Date.parse(generatedAt)
  )
    return null;
  return {
    sourceRevision: value.sourceRevision,
    materializedRevision: value.materializedRevision,
    currentLocalDate: value.currentLocalDate,
    coverageFrom: value.coverageFrom,
    coverageThrough: value.coverageThrough,
    materializedThrough: value.materializedThrough,
    expectedDayCount: value.expectedDayCount,
    materializedDayCount: value.materializedDayCount,
    gapCount: value.gapCount,
    roomTypeIds,
    observedAt: value.observedAt,
  };
}

function localDateAt(instant: string, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date(instant));
  } catch {
    return null;
  }
}

function inclusiveDays(from: string, through: string): number {
  if (!validDate(from) || !validDate(through)) return 0;
  return (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const canonical = value.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_match, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
    );
    return new Date(value).toISOString() === canonical;
  } catch {
    return false;
  }
}

const validHash = (value: string) => /^sha256:[0-9a-f]{64}$/.test(value);
const validHttpsUrl = (value: unknown) => {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
};

const integer = (value: number, minimum: number, maximum = 100) =>
  Number.isInteger(value) && value >= minimum && value <= maximum;
// Setup offers half bathrooms (VAY-2292).
const bathroomCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value * 2) && value >= 0.5 && value <= 100;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
