import type { Hotel } from "@/lib/types";

import { bookingWebPublic, type ApiRequestInit } from "./client";

const FALLBACK_IMAGE = "/vayada-logo.png";
export const PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS = 60;

export type BookingWebPublicHotelResponse = {
  hotel: {
    propertyId: string;
    slug: string;
    name: string;
    canonicalUrl: string;
    bookingBaseUrl: string;
    customDomainUrl: string | null;
    timezone: string;
    defaultLocale: string;
    supportedLocales: string[];
    defaultCurrency: string;
    supportedCurrencies: string[];
    location: {
      country: string;
      city: string;
      region: string | null;
      latitude: number | null;
      longitude: number | null;
    };
    summary: string | null;
    branding?: {
      logoUrl?: string | null;
      showContactButton?: boolean;
      showReferAGuestButton?: boolean;
      showLanguageSelector?: boolean;
      showCurrencySelector?: boolean;
      heroImage: string | null;
      heroHeading: string | null;
      heroSubtext: string | null;
      primaryColor: string | null;
      fontPairing: string | null;
    };
    images: Array<{ url: string; alt: string | null }>;
    amenities: string[];
    publicContacts?: Array<{
      type: "phone" | "email" | "whatsapp" | "website" | "instagram" | "facebook" | "x";
      value: string;
    }>;
    policies: {
      checkInFrom: string | null;
      checkOutUntil: string | null;
      checkInUntil?: string | null;
      checkOutFrom?: string | null;
      cancellationSummary: string | null;
      termsUrl: string | null;
    };
    capabilities: {
      instantBook: boolean;
      onlinePayment: boolean;
      payAtProperty: boolean;
      promoCodes: boolean;
      referralCodes: boolean;
      bookingDeepLinks: boolean;
    };
    supportedQuoteParameters: {
      minRooms: number;
      maxRooms: number;
      minAdults: number;
      maxAdults: number;
      childrenSupported: boolean;
      adultAgeThreshold?: number;
      supportedCurrencies: string[];
      supportedLocales: string[];
    };
  };
};

export type BookingWebPublicHostResponse = {
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  shouldRedirect: boolean;
  redirectUrl: string | null;
  redirectStatus: 308 | null;
  hotel: {
    slug: string;
    name: string;
    defaultLocale: string;
    supportedLocales: string[];
  };
};

function serverBookingWebApiUrl(path: string): string {
  const apiOrigin =
    process.env.BOOKING_WEB_API_URL ||
    process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL ||
    "https://api.localhost";
  return new URL(path, apiOrigin).toString();
}

export const bookingWebPublicApi = {
  async admitAffiliateArrival(
    input: { host: string; referenceToken: string; contextId?: string },
    internalToken: string,
  ): Promise<{ status: "admitted"; contextId: string } | { status: "unavailable" }> {
    return bookingWebPublic.post(
      serverBookingWebApiUrl("/api/booking-web/affiliate/arrivals"),
      input,
      {
        headers: { "X-Vayada-Affiliate-Arrival-Token": internalToken },
        cache: "no-store",
      },
    );
  },

  async resolveHost(host: string, init?: ApiRequestInit): Promise<BookingWebPublicHostResponse> {
    const path = `/api/booking-web/hosts/${encodeURIComponent(host)}`;
    return bookingWebPublic.get<BookingWebPublicHostResponse>(
      typeof window === "undefined" ? serverBookingWebApiUrl(path) : path,
      init,
    );
  },

  async getHotel(
    slug: string,
    query: { locale?: string } = {},
  ): Promise<BookingWebPublicHotelResponse> {
    const params = new URLSearchParams();
    if (query.locale) params.set("locale", query.locale);
    const qs = params.toString();
    return bookingWebPublic.get<BookingWebPublicHotelResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`,
    );
  },
};

export function toLegacyHotel(data: BookingWebPublicHotelResponse): Hotel {
  const hotel = data.hotel;
  const images = hotel.images.map((image) => image.url).filter(Boolean);
  const heroImage = hotel.branding?.heroImage || FALLBACK_IMAGE;
  const contacts = publicContactValues(hotel.publicContacts);
  const address = uniqueNonEmpty([
    hotel.location.city,
    hotel.location.region,
    hotel.location.country,
  ]).join(", ");

  return {
    id: hotel.propertyId,
    name: hotel.name,
    slug: hotel.slug,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    description: hotel.summary || "",
    location: [hotel.location.city, hotel.location.region].filter(Boolean).join(", "),
    country: hotel.location.country,
    starRating: 0,
    currency: hotel.defaultCurrency,
    supportedCurrencies: hotel.supportedCurrencies,
    heroImage,
    images,
    amenities: hotel.amenities,
    checkInTime: hotel.policies.checkInFrom || "",
    checkOutTime: hotel.policies.checkOutUntil || "",
    checkInUntil: hotel.policies.checkInUntil || undefined,
    checkOutFrom: hotel.policies.checkOutFrom || undefined,
    timezone: hotel.timezone,
    contact: {
      address,
      phone: contacts.phone || "",
      email: contacts.email || "",
      whatsapp: contacts.whatsapp || undefined,
      website: safePublicHttpUrl(contacts.website),
    },
    bookingFilters: [],
    customFilters: {},
    filterRooms: {},
    socialLinks: {
      instagram: safePublicHttpUrl(contacts.instagram),
      facebook: safePublicHttpUrl(contacts.facebook),
    },
    branding: hotel.branding
      ? {
          logoUrl: hotel.branding.logoUrl || undefined,
          heroImage: hotel.branding.heroImage || undefined,
          heroHeading: hotel.branding.heroHeading || undefined,
          heroSubtext: hotel.branding.heroSubtext || undefined,
          primaryColor: hotel.branding.primaryColor || undefined,
          fontPairing: hotel.branding.fontPairing || undefined,
        }
      : undefined,
    headerSettings: {
      showContactButton: hotel.branding?.showContactButton ?? true,
      showReferAGuestButton: hotel.branding?.showReferAGuestButton ?? false,
      showLanguageSelector: hotel.branding?.showLanguageSelector ?? true,
      showCurrencySelector: hotel.branding?.showCurrencySelector ?? true,
    },
    defaultLanguage: hotel.defaultLocale,
    supportedLanguages: hotel.supportedLocales,
    guestTypeSettings: {
      adultAgeThreshold: hotel.supportedQuoteParameters.adultAgeThreshold ?? 18,
      childrenEnabled: hotel.supportedQuoteParameters.childrenSupported,
    },
    // New public enrolment is retired; existing referral-code attribution remains supported.
    referAGuestEnabled: false,
    instantBook: hotel.capabilities.instantBook,
  };
}

function publicContactValues(
  contacts: BookingWebPublicHotelResponse["hotel"]["publicContacts"],
): Partial<
  Record<
    NonNullable<BookingWebPublicHotelResponse["hotel"]["publicContacts"]>[number]["type"],
    string
  >
> {
  const values: Partial<
    Record<
      NonNullable<BookingWebPublicHotelResponse["hotel"]["publicContacts"]>[number]["type"],
      string
    >
  > = {};
  for (const contact of contacts ?? []) {
    const value = contact.value.trim();
    if (value && !values[contact.type]) values[contact.type] = value;
  }
  return values;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

function safePublicHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
