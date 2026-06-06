import {
  assertPublicBookabilityPublicSafe,
  buildPublicBookabilityProfileProjection,
  type PublicBookabilityFreshness,
  type PublicBookabilityFreshnessSource,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityProfileProjection,
} from "@vayada/domain-distribution";
import type { FastifyInstance } from "fastify";
import pg from "pg";

export type PublicHotelProfileRepository = {
  findProfileBySlug(slug: string): Promise<PublicBookabilityProfileProjection | null>;
  close?(): Promise<void>;
};

export type BookingHotelProfileRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  location: string | null;
  country: string | null;
  currency: string | null;
  supported_currencies: unknown;
  hero_image: string | null;
  images: unknown;
  amenities: unknown;
  check_in_time: string | null;
  check_out_time: string | null;
  timezone: string | null;
  default_language: string | null;
  supported_languages: unknown;
  custom_domain: string | null;
  instant_book: boolean | null;
  online_card_payment: boolean | null;
  pay_at_property_enabled: boolean | null;
  free_cancellation_days: number | null;
  terms_text: string | null;
  cancellation_policy_text: string | null;
  updated_at: Date | string | null;
};

type PublicHotelProfileParams = {
  slug: string;
};

export async function registerAiHotelRoutes(
  app: FastifyInstance,
  options: { repository: PublicHotelProfileRepository },
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: PublicHotelProfileParams }>("/hotels/:slug", async (request, reply) => {
    const profile = await repository.findProfileBySlug(request.params.slug);
    if (!profile) {
      throw createHttpError(404, "Public hotel profile not found.");
    }

    const response = serializePublicHotelProfileProjection(profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-ai-profile-read");
    return response;
  });
}

export function createPgPublicHotelProfileRepository(config: {
  connectionString: string;
  max?: number;
  bookingHostBase?: string;
}): PublicHotelProfileRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Public hotel profile repository connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findProfileBySlug(slug) {
      const result = await pool.query<BookingHotelProfileRow>(
        `SELECT id, name, slug, description, location, country, currency,
                supported_currencies, hero_image, images, amenities,
                check_in_time, check_out_time, timezone, default_language,
                supported_languages, custom_domain, instant_book,
                online_card_payment, pay_at_property_enabled,
                free_cancellation_days, terms_text, cancellation_policy_text,
                updated_at
         FROM booking_hotels
         WHERE slug = $1`,
        [slug],
      );
      const row = result.rows[0];
      return row
        ? toPublicHotelProfileProjection(row, new Date().toISOString(), {
            bookingHostBase: config.bookingHostBase,
          })
        : null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function toPublicHotelProfileProjection(
  row: BookingHotelProfileRow,
  generatedAt: string,
  options: { bookingHostBase?: string } = {},
): PublicBookabilityProfileProjection {
  const defaultLocale = row.default_language?.trim() || "en";
  const supportedLocales = withRequiredFirst(
    nonEmptyStrings(row.supported_languages, [defaultLocale]),
    defaultLocale,
  );
  const defaultCurrency = row.currency?.trim() || "EUR";
  const supportedCurrencies = withRequiredFirst(
    nonEmptyStrings(row.supported_currencies, [defaultCurrency]),
    defaultCurrency,
  );
  const customDomainUrl = toCustomDomainUrl(row.custom_domain);
  const bookingBaseUrl =
    customDomainUrl ?? fallbackBookingBaseUrl(row.slug, options.bookingHostBase);
  const images = nonEmptyStrings(row.images, []);
  const heroImage = row.hero_image?.trim();
  const lastUpdatedAt = toIsoDateTime(row.updated_at) ?? generatedAt;
  const cancellationSummary =
    row.cancellation_policy_text?.trim() ||
    (row.free_cancellation_days
      ? `Free cancellation until ${row.free_cancellation_days} days before arrival.`
      : null);

  return buildPublicBookabilityProfileProjection(generatedAt, {
    hotelCatalog: {
      propertyId: String(row.id),
      slug: row.slug,
      name: row.name,
      timezone: row.timezone || "UTC",
      defaultLocale,
      supportedLocales,
      location: {
        country: row.country || "",
        city: row.location || "",
      },
      summary: row.description || null,
      images: [heroImage, ...images]
        .filter((url): url is string => Boolean(url))
        .map((url) => ({ url, alt: row.name })),
      amenities: nonEmptyStrings(row.amenities, []),
      profileComplete: Boolean(row.name && row.slug && row.country && row.location),
      profileVerified: true,
      lastUpdatedAt,
    },
    booking: {
      policies: {
        checkInFrom: row.check_in_time ?? null,
        checkOutUntil: row.check_out_time ?? null,
        cancellationSummary,
        termsUrl: row.terms_text?.trim() ? `${bookingBaseUrl}/${defaultLocale}/terms` : null,
      },
      capabilities: {
        instantBook: row.instant_book ?? false,
        promoCodes: true,
        referralCodes: true,
      },
      supportedQuoteParameters: {
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: 8,
        childrenSupported: true,
        supportedCurrencies,
        supportedLocales,
      },
      lastUpdatedAt,
    },
    pms: {
      availabilityReady: false,
      freshness: { status: "unknown", reasonCode: "not_configured" },
    },
    finance: {
      defaultCurrency,
      supportedCurrencies,
      onlinePayment: row.online_card_payment ?? false,
      payAtProperty: row.pay_at_property_enabled ?? false,
      lastUpdatedAt,
    },
    bookingWeb: {
      canonicalUrl: `${bookingBaseUrl}/${defaultLocale}`,
      bookingBaseUrl,
      customDomainUrl,
      domainVerified: Boolean(customDomainUrl),
      bookingDeepLinks: true,
    },
  });
}

export function serializePublicHotelProfileProjection(
  projection: PublicBookabilityProfileProjection,
): PublicBookabilityProfileProjection {
  const hotel = serializeHotelProfile(projection.hotel);
  const freshness = serializeFreshness(projection.freshness);
  const serialized: PublicBookabilityProfileProjection = {
    contractVersion: projection.contractVersion,
    generatedAt: projection.generatedAt,
    publicVisibility: projection.publicVisibility,
    hotel,
    freshness,
    dataSources: projection.dataSources.map((source) => source),
  };

  assertPublicBookabilityPublicSafe(serialized);
  return serialized;
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};

function serializeHotelProfile(
  hotel: PublicBookabilityHotelProfile,
): PublicBookabilityHotelProfile {
  return {
    propertyId: hotel.propertyId,
    slug: hotel.slug,
    name: hotel.name,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    timezone: hotel.timezone,
    defaultLocale: hotel.defaultLocale,
    supportedLocales: hotel.supportedLocales.map((locale) => locale),
    defaultCurrency: hotel.defaultCurrency,
    supportedCurrencies: hotel.supportedCurrencies.map((currency) => currency),
    location: {
      country: hotel.location.country,
      city: hotel.location.city,
      region: hotel.location.region ?? null,
      latitude: hotel.location.latitude ?? null,
      longitude: hotel.location.longitude ?? null,
    },
    summary: hotel.summary ?? null,
    images: hotel.images.map((image) => ({
      url: image.url,
      alt: image.alt ?? null,
    })),
    amenities: hotel.amenities.map((amenity) => amenity),
    policies: {
      checkInFrom: hotel.policies.checkInFrom ?? null,
      checkOutUntil: hotel.policies.checkOutUntil ?? null,
      cancellationSummary: hotel.policies.cancellationSummary ?? null,
      termsUrl: hotel.policies.termsUrl ?? null,
    },
    capabilities: {
      instantBook: hotel.capabilities.instantBook,
      onlinePayment: hotel.capabilities.onlinePayment,
      payAtProperty: hotel.capabilities.payAtProperty,
      promoCodes: hotel.capabilities.promoCodes,
      referralCodes: hotel.capabilities.referralCodes,
      bookingDeepLinks: hotel.capabilities.bookingDeepLinks,
    },
    supportedQuoteParameters: {
      minRooms: hotel.supportedQuoteParameters.minRooms,
      maxRooms: hotel.supportedQuoteParameters.maxRooms,
      minAdults: hotel.supportedQuoteParameters.minAdults,
      maxAdults: hotel.supportedQuoteParameters.maxAdults,
      childrenSupported: hotel.supportedQuoteParameters.childrenSupported,
      supportedCurrencies: hotel.supportedQuoteParameters.supportedCurrencies.map(
        (currency) => currency,
      ),
      supportedLocales: hotel.supportedQuoteParameters.supportedLocales.map((locale) => locale),
    },
    trust: {
      profileComplete: hotel.trust.profileComplete,
      profileVerified: hotel.trust.profileVerified,
      domainVerified: hotel.trust.domainVerified,
      bookabilityStatus: hotel.trust.bookabilityStatus,
      reasonCodes: hotel.trust.reasonCodes.map((reasonCode) => reasonCode),
    },
  };
}

function serializeFreshness(freshness: PublicBookabilityFreshness): PublicBookabilityFreshness {
  return {
    status: freshness.status,
    generatedAt: freshness.generatedAt,
    sources: freshness.sources.map(serializeFreshnessSource),
  };
}

function serializeFreshnessSource(
  source: PublicBookabilityFreshnessSource,
): PublicBookabilityFreshnessSource {
  return {
    owner: source.owner,
    lastUpdatedAt: source.lastUpdatedAt,
    status: source.status,
    reasonCode: source.reasonCode,
  };
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const parsed = typeof value === "string" ? parseJson<unknown>(value, []) : value;
  const values = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return values.length > 0 ? values.map((value) => value.trim()) : fallback;
}

function withRequiredFirst(values: string[], required: string): string[] {
  const normalizedRequired = required.trim();
  return [
    normalizedRequired,
    ...values.filter((value) => value.trim() && value.trim() !== normalizedRequired),
  ];
}

function toCustomDomainUrl(value: string | null): string | null {
  const domain = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return domain ? `https://${domain}` : null;
}

function fallbackBookingBaseUrl(slug: string, bookingHostBase = "booking.vayada.com"): string {
  const hostBase = bookingHostBase
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");

  return `https://${slug}.${hostBase || "booking.vayada.com"}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
