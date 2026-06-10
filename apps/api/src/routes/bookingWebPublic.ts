import {
  assertPublicBookabilityPublicSafe,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityFreshness,
  type PublicBookabilityProfileProjection,
  type PublicBookabilityQuoteProjection,
} from "@vayada/domain-distribution";
import type { FastifyInstance } from "fastify";

import {
  serializePublicHotelQuoteProjection,
  type PublicHotelQuoteQuery,
  type PublicHotelQuoteRepository,
} from "./aiHotelQuotes.js";
import {
  serializePublicHotelProfileProjection,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";

type FetchLike = (input: URL, init?: { signal?: AbortSignal }) => Promise<Response>;

type BookingWebHostParams = {
  host: string;
};

type BookingWebHotelParams = {
  slug: string;
};

type BookingWebCalendarQuery = {
  start?: string;
  end?: string;
};

export type BookingWebHostResolution = {
  contractVersion: typeof PUBLIC_BOOKABILITY_CONTRACT_VERSION;
  publicVisibility: typeof PUBLIC_BOOKABILITY_VISIBILITY;
  host: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  shouldRedirect: boolean;
  redirectUrl: string | null;
  redirectStatus: 308 | null;
  hotel: Pick<
    PublicBookabilityProfileProjection["hotel"],
    "slug" | "name" | "defaultLocale" | "supportedLocales"
  >;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type BookingWebCalendarProjection = {
  contractVersion: typeof PUBLIC_BOOKABILITY_CONTRACT_VERSION;
  generatedAt: string;
  publicVisibility: typeof PUBLIC_BOOKABILITY_VISIBILITY;
  request: {
    hotelSlug: string;
    start: string;
    end: string;
  };
  calendar: {
    unavailableDates: string[];
    minStayByArrival: Record<string, number>;
    maxStayByArrival: Record<string, number>;
  };
  freshness: PublicBookabilityFreshness;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type BookingWebPublicRoutesOptions = {
  profileRepository: PublicHotelProfileRepository;
  quoteRepository?: PublicHotelQuoteRepository;
  bookingPublicApiUrl?: string;
  pmsPublicApiUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
};

export async function registerBookingWebPublicRoutes(
  app: FastifyInstance,
  options: BookingWebPublicRoutesOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  app.get<{ Params: BookingWebHostParams }>("/hosts/:host", async (request, reply) => {
    const host = normalizeHost(request.params.host);
    const profile = await findProfileForHost({
      repository: options.profileRepository,
      host,
      bookingPublicApiUrl: options.bookingPublicApiUrl,
      fetch: fetchImpl,
    });
    if (!profile) {
      throw createHttpError(404, "Booking Web host not found.");
    }

    const response = serializeHostResolution(host, profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-host-read");
    return response;
  });

  app.get<{ Params: BookingWebHotelParams }>("/hotels/:slug", async (request, reply) => {
    const profile = await options.profileRepository.findProfileBySlug(request.params.slug);
    if (!profile) {
      throw createHttpError(404, "Booking Web hotel profile not found.");
    }

    const response = serializePublicHotelProfileProjection(profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-profile-read");
    return response;
  });

  app.get<{ Params: BookingWebHotelParams; Querystring: PublicHotelQuoteQuery }>(
    "/hotels/:slug/offers",
    async (request, reply) => {
      if (!options.quoteRepository) {
        throw createHttpError(404, "Booking Web offers read model not configured.");
      }

      const quote = await options.quoteRepository.findQuoteBySlug(
        request.params.slug,
        request.query,
      );
      if (!quote) {
        throw createHttpError(404, "Booking Web offers not found.");
      }

      const response = serializePublicHotelQuoteProjection(quote);
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-offers-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebHotelParams; Querystring: BookingWebCalendarQuery }>(
    "/hotels/:slug/calendar",
    async (request, reply) => {
      const profile = await options.profileRepository.findProfileBySlug(request.params.slug);
      if (!profile) {
        throw createHttpError(404, "Booking Web hotel calendar not found.");
      }

      const response = await fetchCalendarProjection({
        slug: profile.hotel.slug,
        query: request.query,
        pmsPublicApiUrl: options.pmsPublicApiUrl,
        fetch: fetchImpl,
        now: now(),
      });
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-calendar-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );
}

async function findProfileForHost(config: {
  repository: PublicHotelProfileRepository;
  host: string;
  bookingPublicApiUrl?: string;
  fetch: FetchLike;
}): Promise<PublicBookabilityProfileProjection | null> {
  const { repository, host } = config;
  const subdomainSlug = slugFromKnownBookingHost(host);
  if (subdomainSlug) {
    return repository.findProfileBySlug(subdomainSlug);
  }

  const resolvedSlug = await resolveVerifiedCustomDomainSlug(config);
  if (resolvedSlug) {
    return repository.findProfileBySlug(resolvedSlug);
  }
  if (config.bookingPublicApiUrl?.trim()) {
    return null;
  }

  if (repository.findProfileByCustomDomain) {
    return repository.findProfileByCustomDomain(host);
  }

  return null;
}

async function resolveVerifiedCustomDomainSlug(config: {
  host: string;
  bookingPublicApiUrl?: string;
  fetch: FetchLike;
}): Promise<string | null> {
  if (!config.bookingPublicApiUrl?.trim()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const url = new URL("/api/resolve-domain", config.bookingPublicApiUrl);
    url.searchParams.set("domain", config.host);
    const response = await config.fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const slug = (payload as Record<string, unknown>)["slug"];
    return typeof slug === "string" && slug.trim() ? slug.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function serializeHostResolution(
  host: string,
  projection: PublicBookabilityProfileProjection,
): BookingWebHostResolution {
  const hotel = serializePublicHotelProfileProjection(projection).hotel;
  const canonicalHost = hostFromUrl(hotel.bookingBaseUrl);
  const shouldRedirect = Boolean(canonicalHost && canonicalHost !== host);
  return {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    host,
    slug: hotel.slug,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    shouldRedirect,
    redirectUrl: shouldRedirect ? hotel.canonicalUrl : null,
    redirectStatus: shouldRedirect ? 308 : null,
    hotel: {
      slug: hotel.slug,
      name: hotel.name,
      defaultLocale: hotel.defaultLocale,
      supportedLocales: hotel.supportedLocales.map((locale) => locale),
    },
    dataSources: projection.dataSources.map((source) => source),
  };
}

async function fetchCalendarProjection(config: {
  slug: string;
  query: BookingWebCalendarQuery;
  pmsPublicApiUrl?: string;
  fetch: FetchLike;
  now: Date;
}): Promise<BookingWebCalendarProjection> {
  const generatedAt = config.now.toISOString();
  const start = normalizeDateOnly(config.query.start);
  const end = normalizeDateOnly(config.query.end);
  if (!start || !end || start >= end || !config.pmsPublicApiUrl?.trim()) {
    return unavailableCalendar(config.slug, start, end, generatedAt);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const url = new URL(
      `/api/hotels/${encodeURIComponent(config.slug)}/unavailable-dates`,
      config.pmsPublicApiUrl,
    );
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);

    const response = await config.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return unavailableCalendar(config.slug, start, end, generatedAt);
    }

    const payload = normalizeLegacyCalendarPayload(await response.json());
    return {
      contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
      generatedAt,
      publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
      request: { hotelSlug: config.slug, start, end },
      calendar: payload,
      freshness: freshness(generatedAt, "fresh"),
      dataSources: ["pms", "distribution"],
    };
  } catch {
    return unavailableCalendar(config.slug, start, end, generatedAt);
  } finally {
    clearTimeout(timeout);
  }
}

function unavailableCalendar(
  slug: string,
  start: string | null,
  end: string | null,
  generatedAt: string,
): BookingWebCalendarProjection {
  return {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request: {
      hotelSlug: slug,
      start: start ?? "",
      end: end ?? "",
    },
    calendar: {
      unavailableDates: [],
      minStayByArrival: {},
      maxStayByArrival: {},
    },
    freshness: freshness(generatedAt, "unavailable"),
    dataSources: ["pms", "distribution"],
  };
}

function normalizeLegacyCalendarPayload(value: unknown): BookingWebCalendarProjection["calendar"] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const raw = record as Record<string, unknown>;
  return {
    unavailableDates: stringArray(raw["dates"]),
    minStayByArrival: numberRecord(raw["min_stay_by_arrival"]),
    maxStayByArrival: numberRecord(raw["max_stay_by_arrival"]),
  };
}

function freshness(
  generatedAt: string,
  pmsStatus: PublicBookabilityFreshness["status"],
): PublicBookabilityFreshness {
  return {
    status: pmsStatus === "fresh" ? "fresh" : "unavailable",
    generatedAt,
    sources: [
      {
        owner: "pms",
        lastUpdatedAt: pmsStatus === "fresh" ? generatedAt : undefined,
        status: pmsStatus,
        reasonCode: pmsStatus === "fresh" ? undefined : "source_unavailable",
      },
      {
        owner: "distribution",
        lastUpdatedAt: generatedAt,
        status: "fresh",
      },
    ],
  };
}

function normalizeHost(value: string): string {
  const decoded = decodeURIComponent(value).trim().toLowerCase();
  if (decoded.startsWith("[")) {
    return decoded.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return decoded.replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
}

function slugFromKnownBookingHost(host: string): string | null {
  const parts = host.split(".");
  if (host.endsWith(".booking.vayada.com") || host.endsWith(".booking.localhost")) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  return null;
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeDateOnly(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]),
    ),
  );
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
