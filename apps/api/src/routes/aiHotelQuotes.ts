import {
  assertPublicBookabilityPublicSafe,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityFreshness,
  type PublicBookabilityFreshnessSource,
  type PublicBookabilityFreshnessStatus,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityOffer,
  type PublicBookabilityQuoteProjection,
  type PublicBookabilityQuoteRequest,
  type PublicBookabilityReasonCode,
  type PublicBookabilityUnavailableReason,
} from "@vayada/domain-distribution";
import type { FastifyInstance } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PublicHotelProfileRepository } from "./aiHotels.js";

export type PublicHotelQuoteQuery = {
  check_in?: string;
  check_out?: string;
  adults?: string;
  children?: string;
  rooms?: string;
  currency?: string;
  locale?: string;
  promo_code?: string;
  referral_code?: string;
};

export type PublicHotelQuoteRepository = {
  findQuoteBySlug(
    slug: string,
    query: PublicHotelQuoteQuery,
  ): Promise<PublicBookabilityQuoteProjection | null>;
  close?(): Promise<void>;
};

export type PublicHotelQuoteReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type PublicHotelQuoteParams = {
  slug: string;
};

const PUBLIC_QUOTE_DATA_SOURCES: PublicBookabilityDataSourceOwner[] = [
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "distribution",
];
const PUBLIC_QUOTE_MAX_NIGHTS = 30;
const PUBLIC_QUOTE_MAX_ADVANCE_DAYS = 365;

export async function registerAiHotelQuoteRoutes(
  app: FastifyInstance,
  options: { repository: PublicHotelQuoteRepository },
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: PublicHotelQuoteParams; Querystring: PublicHotelQuoteQuery }>(
    "/hotels/:slug/quote",
    async (request, reply) => {
      const quote = await repository.findQuoteBySlug(request.params.slug, request.query);
      if (!quote) {
        throw createHttpError(404, "Public hotel quote not found.");
      }

      const response = serializePublicHotelQuoteProjection(quote);
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
      reply.header("X-Vayada-RateLimit-Policy", "public-ai-quote-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );
}

export function createTargetPublicHotelQuoteRepository(config: {
  connectionString: string;
  profileRepository: PublicHotelProfileRepository;
  mixedRoomSelectionsEnabled?: boolean;
  max?: number;
  pool?: PublicHotelQuoteReadPool;
  now?: () => Date;
}): PublicHotelQuoteRepository {
  const now = config.now ?? (() => new Date());
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async findQuoteBySlug(slug, query) {
      throw Object.assign(
        new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
        { statusCode: 503, code: "PRICING_UNAVAILABLE" },
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export function toUnavailablePublicHotelQuoteProjection(
  hotel: PublicBookabilityHotelProfile,
  query: PublicHotelQuoteQuery,
  now: Date,
  profileReasons: PublicBookabilityUnavailableReason[] = [],
): PublicBookabilityQuoteProjection {
  const generatedAt = now.toISOString();
  const { request, reasons } = parsePublicHotelQuoteRequest(hotel, query, now);
  const readModelUnavailableReason: PublicBookabilityUnavailableReason = {
    code: "unavailable_data",
    detail: "Public quote read model is not ready yet.",
  };
  const unavailableReasons = dedupeReasons(
    reasons.length > 0
      ? reasons
      : profileReasons.length > 0
        ? profileReasons
        : [readModelUnavailableReason],
  );
  const freshness = unavailableQuoteFreshness(generatedAt, unavailableReasons);

  const projection: PublicBookabilityQuoteProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request,
    status:
      freshness.status === "stale" &&
      unavailableReasons.every((reason) => reason.code === "stale_data")
        ? "stale"
        : "unavailable",
    unavailableReasons,
    freshness,
    dataSources: PUBLIC_QUOTE_DATA_SOURCES,
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

export function serializePublicHotelQuoteProjection(
  projection: PublicBookabilityQuoteProjection,
): PublicBookabilityQuoteProjection {
  const serialized: PublicBookabilityQuoteProjection = {
    contractVersion: projection.contractVersion,
    generatedAt: projection.generatedAt,
    publicVisibility: projection.publicVisibility,
    request: {
      hotelSlug: projection.request.hotelSlug,
      checkIn: projection.request.checkIn,
      checkOut: projection.request.checkOut,
      nights: projection.request.nights,
      adults: projection.request.adults,
      children: projection.request.children,
      rooms: projection.request.rooms,
      currency: projection.request.currency,
      locale: projection.request.locale,
      promoCode: projection.request.promoCode ?? null,
      referralCode: projection.request.referralCode ?? null,
    },
    status: projection.status,
    unavailableReasons: projection.unavailableReasons.map((reason) => ({
      code: reason.code,
      detail: reason.detail,
    })),
    quote: projection.quote
      ? {
          quoteId: projection.quote.quoteId,
          quoteHash: projection.quote.quoteHash,
          expiresAt: projection.quote.expiresAt,
          priceGuarantee: projection.quote.priceGuarantee,
          offers: projection.quote.offers.map(serializeOffer),
        }
      : undefined,
    deepLink: projection.deepLink
      ? {
          url: projection.deepLink.url,
          expiresAt: projection.deepLink.expiresAt ?? null,
          preserves: projection.deepLink.preserves.map((value) => value),
        }
      : undefined,
    freshness: serializeFreshness(projection.freshness),
    dataSources: projection.dataSources.map((source) => source),
  };

  assertPublicBookabilityPublicSafe(serialized);
  validatePublicQuoteUrls(serialized);
  return serialized;
}

function parsePublicHotelQuoteRequest(
  hotel: PublicBookabilityHotelProfile,
  query: PublicHotelQuoteQuery,
  now: Date,
): { request: PublicBookabilityQuoteRequest; reasons: PublicBookabilityUnavailableReason[] } {
  const defaultCurrency = hotel.defaultCurrency;
  const defaultLocale = hotel.defaultLocale;
  const checkIn = normalizeDateOnly(query.check_in) ?? "";
  const checkOut = normalizeDateOnly(query.check_out) ?? "";
  const parsedAdults = parsePublicInteger(query.adults, hotel.supportedQuoteParameters.minAdults);
  const parsedChildren = parsePublicInteger(query.children, 0);
  const parsedRooms = parsePublicInteger(query.rooms, hotel.supportedQuoteParameters.minRooms);
  const adults = parsedAdults.value;
  const children = parsedChildren.value;
  const rooms = parsedRooms.value;
  const currency = (query.currency?.trim() || defaultCurrency).toUpperCase();
  const locale = query.locale?.trim() || defaultLocale;
  const nights = checkIn && checkOut ? Math.max(0, daysBetweenDateOnly(checkIn, checkOut) ?? 0) : 0;
  const request: PublicBookabilityQuoteRequest = {
    hotelSlug: hotel.slug,
    checkIn,
    checkOut,
    nights,
    adults,
    children,
    rooms,
    currency,
    locale,
    promoCode: sanitizePublicCode(query.promo_code),
    referralCode: sanitizePublicCode(query.referral_code),
  };
  const reasons: PublicBookabilityUnavailableReason[] = [];
  const timezoneValid = isValidTimeZone(hotel.timezone);

  if (!timezoneValid) {
    reasons.push({
      code: "unavailable_data",
      detail: "Hotel timezone is unavailable.",
    });
  }

  if (!query.check_in || !query.check_out || !checkIn || !checkOut || nights <= 0) {
    reasons.push({
      code: "invalid_request",
      detail: "check_in and check_out must be ISO dates and check_out must be after check_in.",
    });
  }

  if (parsedAdults.invalid || parsedChildren.invalid || parsedRooms.invalid) {
    reasons.push({
      code: "invalid_request",
      detail: "adults, children, and rooms must be non-negative integers.",
    });
  }

  if (
    adults < hotel.supportedQuoteParameters.minAdults ||
    adults > hotel.supportedQuoteParameters.maxAdults ||
    rooms < hotel.supportedQuoteParameters.minRooms ||
    rooms > hotel.supportedQuoteParameters.maxRooms ||
    (!hotel.supportedQuoteParameters.childrenSupported && children > 0)
  ) {
    reasons.push({ code: "unsupported_occupancy" });
  }

  if (request.promoCode) {
    reasons.push({
      code: "promo_not_applicable",
      detail: "Public promo-aware quote pricing is not available yet.",
    });
  }

  if (nights > PUBLIC_QUOTE_MAX_NIGHTS) {
    reasons.push({
      code: "max_stay_exceeded",
      detail: `Public quote requests are limited to ${PUBLIC_QUOTE_MAX_NIGHTS} nights.`,
    });
  }

  if (!hotel.supportedCurrencies.includes(currency)) {
    reasons.push({ code: "currency_not_supported" });
  }

  if (!hotel.supportedLocales.includes(locale)) {
    reasons.push({ code: "locale_not_supported" });
  }

  if (checkIn && timezoneValid && isBeforePropertyToday(checkIn, hotel.timezone, now)) {
    reasons.push({ code: "invalid_request", detail: "check_in cannot be in the past." });
  }

  if (
    checkIn &&
    timezoneValid &&
    daysBetweenDateOnly(propertyDateOnly(hotel.timezone, now), checkIn)! >
      PUBLIC_QUOTE_MAX_ADVANCE_DAYS
  ) {
    reasons.push({
      code: "invalid_request",
      detail: `check_in must be within ${PUBLIC_QUOTE_MAX_ADVANCE_DAYS} days.`,
    });
  }

  return {
    request,
    reasons: dedupeReasons(reasons),
  };
}

function unavailableQuoteFreshness(
  generatedAt: string,
  reasons: PublicBookabilityUnavailableReason[],
): PublicBookabilityFreshness {
  const pmsStatus: PublicBookabilityFreshnessStatus = reasons.some(
    (reason) => reason.code === "unavailable_data",
  )
    ? "unavailable"
    : reasons.some((reason) => reason.code === "stale_data")
      ? "stale"
      : "unknown";
  const pmsReasonCode =
    pmsStatus === "unavailable"
      ? "source_unavailable"
      : pmsStatus === "stale"
        ? "source_stale"
        : "not_configured";
  const sources: PublicBookabilityFreshnessSource[] = [
    { owner: "hotel_catalog", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "booking", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "pms", status: pmsStatus, reasonCode: pmsReasonCode },
    { owner: "finance", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "distribution", lastUpdatedAt: generatedAt, status: "fresh" },
  ];

  return {
    status: pmsStatus,
    generatedAt,
    sources,
  };
}

function reasonCode(value: string | null): PublicBookabilityReasonCode | null {
  if (
    value === "sold_out" ||
    value === "stay_restricted" ||
    value === "payment_disabled" ||
    value === "min_stay_not_met" ||
    value === "max_stay_exceeded" ||
    value === "same_day_cutoff_passed" ||
    value === "unsupported_occupancy" ||
    value === "occupancy_unavailable" ||
    value === "unpublished" ||
    value === "policy_missing" ||
    value === "stale_data" ||
    value === "unavailable_data" ||
    value === "invalid_request" ||
    value === "currency_not_supported" ||
    value === "locale_not_supported" ||
    value === "promo_not_applicable"
  ) {
    return value;
  }
  return null;
}

function serializeOffer(offer: PublicBookabilityOffer): PublicBookabilityOffer {
  return {
    ...(offer.roomSelection
      ? {
          roomSelection: offer.roomSelection,
          roomLines: offer.roomLines,
          expiresAt: offer.expiresAt,
        }
      : {}),
    offerId: offer.offerId,
    roomTypeId: offer.roomTypeId,
    ratePlanId: offer.ratePlanId ?? null,
    name: offer.name,
    locationAddress: offer.locationAddress ?? null,
    latitude: offer.latitude ?? null,
    longitude: offer.longitude ?? null,
    occupancy: {
      maxAdults: offer.occupancy.maxAdults,
      maxChildren: offer.occupancy.maxChildren,
    },
    availableRooms: offer.availableRooms,
    refundable: offer.refundable,
    mealPlan: offer.mealPlan ?? null,
    amenities: offer.amenities.map((amenity) => amenity),
    paymentOptions: offer.paymentOptions.map((option) => option),
    totals: {
      currency: offer.totals.currency,
      roomTotal: offer.totals.roomTotal,
      taxesAndFees: offer.totals.taxesAndFees,
      discounts: offer.totals.discounts,
      grandTotal: offer.totals.grandTotal,
      ...(offer.totals.promotion
        ? {
            promotion: {
              name: offer.totals.promotion.name,
              discountAmount: offer.totals.promotion.discountAmount,
              discountPercent: offer.totals.promotion.discountPercent,
            },
          }
        : {}),
    },
    policies: {
      cancellation: offer.policies.cancellation ?? null,
      deposit: offer.policies.deposit ?? null,
    },
    bookingUrl: offer.bookingUrl,
  };
}

function validatePublicQuoteUrls(projection: PublicBookabilityQuoteProjection): void {
  const urls = [
    projection.deepLink?.url,
    ...(projection.quote?.offers.map((offer) => offer.bookingUrl) ?? []),
  ].filter((url): url is string => Boolean(url));
  if (urls.length === 0) return;

  const parsed = urls.map((url) => new URL(url));
  const origin = parsed[0]!.origin;
  for (const url of parsed) {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Public quote URL must use http or https.");
    }
    if (url.origin !== origin) {
      throw new Error("Public quote URLs must share the canonical booking origin.");
    }
    if (!url.pathname.endsWith("/book")) {
      throw new Error("Public quote URLs must point to the booking flow.");
    }
  }
}

function serializeFreshness(freshness: PublicBookabilityFreshness): PublicBookabilityFreshness {
  return {
    status: freshness.status,
    generatedAt: freshness.generatedAt,
    sources: freshness.sources.map((source) => ({
      owner: source.owner,
      lastUpdatedAt: source.lastUpdatedAt,
      status: source.status,
      reasonCode: source.reasonCode,
    })),
  };
}

function normalizeDateOnly(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function parsePublicInteger(
  value: string | undefined,
  fallback: number,
): { value: number; invalid: boolean } {
  if (!value) return { value: fallback, invalid: false };
  if (!/^\d+$/.test(value)) return { value: fallback, invalid: true };
  return { value: Number.parseInt(value, 10), invalid: false };
}

function daysBetweenDateOnly(start: string, end: string): number | null {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.round((endMs - startMs) / 86_400_000);
}

function sanitizePublicCode(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

function isBeforePropertyToday(checkIn: string, timezone: string, now: Date): boolean {
  return checkIn < propertyDateOnly(timezone, now);
}

function isValidTimeZone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function propertyDateOnly(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function dedupeReasons(
  reasons: PublicBookabilityUnavailableReason[],
): PublicBookabilityUnavailableReason[] {
  const seen = new Set<PublicBookabilityReasonCode>();
  return reasons.filter((reason) => {
    if (seen.has(reason.code)) return false;
    seen.add(reason.code);
    return true;
  });
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
