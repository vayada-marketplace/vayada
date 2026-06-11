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

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

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

type BookingWebBookingHandleParams = BookingWebHotelParams & {
  handle: string;
};

type BookingWebBookingIdParams = BookingWebHotelParams & {
  bookingId: string;
};

type BookingWebBookingStatusQuery = {
  reference?: string;
  email?: string;
};

type BookingWebGuestActionRequest = {
  guestEmail?: string;
  guest_email?: string;
};

type BookingWebCheckoutRequest = Record<string, unknown>;
type BookingWebLookupRequest = {
  bookingReference?: string;
  guestEmail?: string;
};
type BookingWebChangeRequest = {
  guestEmail?: string;
  guest_email?: string;
  checkIn?: string;
  checkOut?: string;
  addonIds?: string[];
  addonQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
};
type BookingWebChangeRequestQuery = {
  email?: string;
};
type BookingWebPromoValidationRequest = {
  code?: string;
};

export type BookingWebPaymentInstructions = {
  bankTransfer: {
    enabled: boolean;
    details: unknown | null;
  };
  paypal: {
    enabled: boolean;
    email: string | null;
    paymentWindowHours: number | null;
  };
};

export type BookingWebCheckoutAdapter = {
  getCheckoutConfig(slug: string): Promise<unknown>;
  createBooking(slug: string, request: BookingWebCheckoutRequest): Promise<unknown>;
  confirmAuthorization(slug: string, handle: string): Promise<unknown>;
  getStatus(slug: string, query: BookingWebBookingStatusQuery): Promise<unknown>;
  lookup(slug: string, request: BookingWebLookupRequest): Promise<unknown>;
  withdraw(
    slug: string,
    bookingId: string,
    request: BookingWebGuestActionRequest,
  ): Promise<unknown>;
  cancelPreview(
    slug: string,
    bookingId: string,
    request: BookingWebGuestActionRequest,
  ): Promise<unknown>;
  cancel(slug: string, bookingId: string, request: BookingWebGuestActionRequest): Promise<unknown>;
  previewChangeRequest(
    slug: string,
    bookingId: string,
    request: BookingWebChangeRequest,
  ): Promise<unknown>;
  submitChangeRequest(
    slug: string,
    bookingId: string,
    request: BookingWebChangeRequest,
  ): Promise<unknown>;
  getChangeRequest(
    slug: string,
    bookingId: string,
    query: BookingWebChangeRequestQuery,
  ): Promise<unknown>;
  getPaymentInstructions(slug: string, handle: string): Promise<BookingWebPaymentInstructions>;
  validatePromo(slug: string, request: BookingWebPromoValidationRequest): Promise<unknown>;
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
  legacyCheckoutCommandProxyEnabled?: boolean;
  checkoutAdapter?: BookingWebCheckoutAdapter;
  fetch?: FetchLike;
  now?: () => Date;
};

export async function registerBookingWebPublicRoutes(
  app: FastifyInstance,
  options: BookingWebPublicRoutesOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const checkoutAdapter =
    options.checkoutAdapter ??
    createCompatibilityBookingWebCheckoutAdapter({
      pmsPublicApiUrl: options.pmsPublicApiUrl,
      bookingPublicApiUrl: options.bookingPublicApiUrl,
      legacyCheckoutCommandProxyEnabled: options.legacyCheckoutCommandProxyEnabled,
      fetch: fetchImpl,
    });

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

  app.get<{ Params: BookingWebHotelParams }>(
    "/hotels/:slug/checkout-config",
    async (request, reply) => {
      const response = await checkoutAdapter.getCheckoutConfig(request.params.slug);
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-checkout-config");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebCheckoutRequest }>(
    "/hotels/:slug/bookings",
    async (request, reply) => {
      const response = await checkoutAdapter.createBooking(request.params.slug, request.body ?? {});
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-create");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingHandleParams }>(
    "/hotels/:slug/bookings/:handle/confirm-authorization",
    async (request, reply) => {
      const response = await checkoutAdapter.confirmAuthorization(
        request.params.slug,
        request.params.handle,
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-confirm");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebHotelParams; Querystring: BookingWebBookingStatusQuery }>(
    "/hotels/:slug/bookings/status",
    async (request, reply) => {
      const response = await checkoutAdapter.getStatus(request.params.slug, request.query);
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-status");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebLookupRequest }>(
    "/hotels/:slug/bookings/lookup",
    async (request, reply) => {
      const response = await checkoutAdapter.lookup(request.params.slug, request.body ?? {});
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-lookup");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/withdraw",
    async (request, reply) => {
      const response = await checkoutAdapter.withdraw(
        request.params.slug,
        request.params.bookingId,
        request.body ?? {},
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-withdraw");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/cancel-preview",
    async (request, reply) => {
      const response = await checkoutAdapter.cancelPreview(
        request.params.slug,
        request.params.bookingId,
        request.body ?? {},
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-cancel-preview");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/cancel",
    async (request, reply) => {
      const response = await checkoutAdapter.cancel(
        request.params.slug,
        request.params.bookingId,
        request.body ?? {},
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-cancel");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebChangeRequest }>(
    "/hotels/:slug/bookings/:bookingId/change-request/preview",
    async (request, reply) => {
      const response = await checkoutAdapter.previewChangeRequest(
        request.params.slug,
        request.params.bookingId,
        request.body ?? {},
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-preview");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebChangeRequest }>(
    "/hotels/:slug/bookings/:bookingId/change-request",
    async (request, reply) => {
      const response = await checkoutAdapter.submitChangeRequest(
        request.params.slug,
        request.params.bookingId,
        request.body ?? {},
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-submit");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebBookingIdParams; Querystring: BookingWebChangeRequestQuery }>(
    "/hotels/:slug/bookings/:bookingId/change-request",
    async (request, reply) => {
      const response = await checkoutAdapter.getChangeRequest(
        request.params.slug,
        request.params.bookingId,
        request.query,
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-get");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebBookingHandleParams }>(
    "/hotels/:slug/bookings/:handle/payment-instructions",
    async (request, reply) => {
      const response = await checkoutAdapter.getPaymentInstructions(
        request.params.slug,
        request.params.handle,
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-payment-instructions");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebPromoValidationRequest }>(
    "/hotels/:slug/promo/validate",
    async (request, reply) => {
      const response = await checkoutAdapter.validatePromo(request.params.slug, request.body ?? {});
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-promo-validate");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );
}

export function createCompatibilityBookingWebCheckoutAdapter(config: {
  pmsPublicApiUrl?: string;
  bookingPublicApiUrl?: string;
  legacyCheckoutCommandProxyEnabled?: boolean;
  fetch?: FetchLike;
}): BookingWebCheckoutAdapter {
  const fetchImpl = config.fetch ?? fetch;
  const pmsPublicApiUrl = config.pmsPublicApiUrl?.trim();
  const bookingPublicApiUrl = config.bookingPublicApiUrl?.trim();
  // Legacy write proxying is an explicit transitional escape hatch until Booking
  // owns idempotency, audit visibility, and PMS reservation sink handoff here.
  const legacyCheckoutCommandProxyEnabled = config.legacyCheckoutCommandProxyEnabled === true;
  const proxyBookingCommand = (
    slug: string,
    bookingId: string,
    command: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> => {
    assertLegacyCheckoutCommandProxyEnabled(legacyCheckoutCommandProxyEnabled);
    return fetchJson({
      baseUrl: pmsPublicApiUrl,
      path: bookingCommandPath(slug, bookingId, command),
      method,
      body,
      fetch: fetchImpl,
    });
  };

  return {
    async getCheckoutConfig(slug) {
      const settings = await fetchJson<Record<string, unknown>>({
        baseUrl: pmsPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/payment-settings`,
        method: "GET",
        fetch: fetchImpl,
      });
      return sanitizeCheckoutConfig(settings);
    },
    async createBooking(slug, request) {
      assertLegacyCheckoutCommandProxyEnabled(legacyCheckoutCommandProxyEnabled);
      return fetchJson({
        baseUrl: pmsPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/bookings`,
        method: "POST",
        body: request,
        fetch: fetchImpl,
      });
    },
    async confirmAuthorization(slug, handle) {
      assertLegacyCheckoutCommandProxyEnabled(legacyCheckoutCommandProxyEnabled);
      return fetchJson({
        baseUrl: pmsPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(handle)}/confirm-authorization`,
        method: "POST",
        fetch: fetchImpl,
      });
    },
    async getStatus(slug, query) {
      const params = new URLSearchParams();
      if (query.reference) params.set("reference", query.reference);
      if (query.email) params.set("email", query.email);
      return fetchJson({
        baseUrl: pmsPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/bookings/status?${params.toString()}`,
        method: "GET",
        fetch: fetchImpl,
      });
    },
    async lookup(slug, request) {
      return fetchJson({
        baseUrl: pmsPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/bookings/lookup`,
        method: "POST",
        body: request,
        fetch: fetchImpl,
      });
    },
    async withdraw(slug, bookingId, request) {
      return proxyBookingCommand(
        slug,
        bookingId,
        "withdraw",
        "POST",
        normalizeGuestActionRequest(request),
      );
    },
    async cancelPreview(slug, bookingId, request) {
      return proxyBookingCommand(
        slug,
        bookingId,
        "cancel-preview",
        "POST",
        normalizeGuestActionRequest(request),
      );
    },
    async cancel(slug, bookingId, request) {
      return proxyBookingCommand(
        slug,
        bookingId,
        "cancel",
        "POST",
        normalizeGuestActionRequest(request),
      );
    },
    async previewChangeRequest(slug, bookingId, request) {
      return proxyBookingCommand(
        slug,
        bookingId,
        "change-request/preview",
        "POST",
        normalizeChangeRequest(request),
      );
    },
    async submitChangeRequest(slug, bookingId, request) {
      const response = await proxyBookingCommand(
        slug,
        bookingId,
        "change-request",
        "POST",
        normalizeChangeRequest(request),
      );
      return sanitizeChangeRequestResponse(response);
    },
    async getChangeRequest(slug, bookingId, query) {
      const params = new URLSearchParams();
      if (query.email) params.set("email", query.email);
      const response = await proxyBookingCommand(
        slug,
        bookingId,
        `change-request?${params.toString()}`,
        "GET",
      );
      return sanitizeChangeRequestResponse(response);
    },
    async getPaymentInstructions() {
      throw createHttpError(404, "Booking-scoped payment instructions are not configured.");
    },
    async validatePromo(slug, request) {
      const code = typeof request.code === "string" ? request.code.trim() : "";
      if (!code) {
        return { valid: false, code, message: "Promo code is required" };
      }
      return fetchJson({
        baseUrl: bookingPublicApiUrl,
        path: `/api/hotels/${encodeURIComponent(slug)}/validate-promo?${new URLSearchParams({
          code,
        }).toString()}`,
        method: "GET",
        fetch: fetchImpl,
      });
    },
  };
}

function assertLegacyCheckoutCommandProxyEnabled(enabled: boolean): void {
  if (!enabled) {
    throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
  }
}

function bookingCommandPath(slug: string, bookingId: string, command: string): string {
  return `/api/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(bookingId)}/${command}`;
}

function normalizeGuestActionRequest(request: BookingWebGuestActionRequest): {
  guest_email: string | undefined;
} {
  return {
    guest_email: request.guest_email ?? request.guestEmail,
  };
}

function normalizeChangeRequest(request: BookingWebChangeRequest): Record<string, unknown> {
  return {
    guestEmail: request.guestEmail ?? request.guest_email,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    addonIds: Array.isArray(request.addonIds) ? request.addonIds : [],
    addonQuantities: request.addonQuantities ?? {},
    addonDates: request.addonDates ?? {},
  };
}

function sanitizeChangeRequestResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const sanitized = { ...(value as Record<string, unknown>) };
  delete sanitized["decisionToken"];
  delete sanitized["decision_token"];
  return sanitized;
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

function sanitizeCheckoutConfig(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...settings };
  delete sanitized["bankDetails"];
  delete sanitized["paypalEmail"];
  return sanitized;
}

async function fetchJson<T = unknown>(config: {
  baseUrl?: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  fetch: FetchLike;
}): Promise<T> {
  if (!config.baseUrl?.trim()) {
    throw createHttpError(404, "Booking Web checkout adapter is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await config.fetch(new URL(config.path, config.baseUrl), {
      signal: controller.signal,
      method: config.method,
      headers: config.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      throw createHttpError(response.status, legacyErrorMessage(payload));
    }
    return payload as T;
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw createHttpError(502, "Booking Web checkout adapter request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function legacyErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Booking Web checkout adapter request failed.";
  }
  const detail = (payload as Record<string, unknown>)["detail"];
  return typeof detail === "string" && detail.trim()
    ? detail
    : "Booking Web checkout adapter request failed.";
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

type HttpError = Error & {
  statusCode: number;
};
