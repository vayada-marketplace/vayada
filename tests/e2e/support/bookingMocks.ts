import type { Page } from "@playwright/test";

export const SEEDED_BOOKING_SLUG = "hotel-alpenrose";

const hotel = {
  id: "hotel-alpenrose-id",
  name: "Hotel Alpenrose",
  slug: SEEDED_BOOKING_SLUG,
  canonicalUrl: "http://hotel-alpenrose.booking.localhost:3002/en",
  bookingBaseUrl: "http://hotel-alpenrose.booking.localhost:3002",
  customDomainUrl: null,
  description: "A warm alpine retreat for direct booking guests.",
  location: "Zermatt",
  country: "Switzerland",
  starRating: 4,
  currency: "EUR",
  supportedCurrencies: ["EUR", "USD"],
  heroImage: "/vayada-logo.png",
  images: ["/vayada-logo.png"],
  amenities: ["Free WiFi", "Spa", "Breakfast"],
  checkInTime: "15:00",
  checkOutTime: "11:00",
  timezone: "Europe/Zurich",
  contact: {
    address: "Alpenstrasse 1, Zermatt",
    phone: "+41 44 000 00 00",
    email: "stay@alpenrose.test",
  },
  bookingFilters: ["includeBreakfast", "freeCancellation"],
  customFilters: {},
  filterRooms: {},
  branding: {
    primaryColor: "#2563eb",
    accentColor: "#eff6ff",
    fontPairing: "modern-minimalist",
    logoUrl: "/vayada-logo.png",
  },
  defaultLanguage: "en",
  supportedLanguages: ["en", "de", "nl"],
  referAGuestEnabled: true,
  instantBook: true,
};

const publicHotelProfile = {
  contractVersion: "public-bookability.v1",
  generatedAt: "2026-06-06T11:00:00.000Z",
  publicVisibility: "public_safe",
  hotel: {
    propertyId: hotel.id,
    slug: hotel.slug,
    name: hotel.name,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    timezone: hotel.timezone,
    defaultLocale: hotel.defaultLanguage,
    supportedLocales: hotel.supportedLanguages,
    defaultCurrency: hotel.currency,
    supportedCurrencies: hotel.supportedCurrencies,
    location: {
      country: hotel.country,
      city: hotel.location,
      region: null,
      latitude: null,
      longitude: null,
    },
    summary: hotel.description,
    images: hotel.images.map((url) => ({ url, alt: hotel.name })),
    amenities: hotel.amenities,
    publicContacts: [
      { type: "email", value: hotel.contact.email },
      { type: "phone", value: hotel.contact.phone },
    ],
    policies: {
      checkInFrom: hotel.checkInTime,
      checkOutUntil: hotel.checkOutTime,
      cancellationSummary: null,
      termsUrl: null,
    },
    capabilities: {
      instantBook: hotel.instantBook,
      onlinePayment: true,
      payAtProperty: true,
      promoCodes: true,
      referralCodes: hotel.referAGuestEnabled,
      bookingDeepLinks: true,
    },
    supportedQuoteParameters: {
      minRooms: 1,
      maxRooms: 4,
      minAdults: 1,
      maxAdults: 8,
      childrenSupported: true,
      adultAgeThreshold: 18,
      supportedCurrencies: hotel.supportedCurrencies,
      supportedLocales: hotel.supportedLanguages,
    },
    trust: {
      profileComplete: true,
      profileVerified: true,
      domainVerified: true,
      bookabilityStatus: "bookable",
      reasonCodes: [],
    },
  },
  freshness: {
    status: "fresh",
    generatedAt: "2026-06-06T11:00:00.000Z",
    sources: [],
  },
  dataSources: ["hotel_catalog", "booking", "pms", "distribution"],
};

const rooms = [
  {
    id: "alpine-suite",
    name: "Alpine Suite",
    category: "Suite",
    description: "A bright suite with mountain views and a private balcony.",
    shortDescription: "Mountain-view suite with balcony.",
    maxOccupancy: 3,
    maxAdults: 3,
    maxChildren: 1,
    size: 42,
    baseRate: 240,
    nonRefundableRate: 210,
    currency: "EUR",
    amenities: [
      "Wi-Fi",
      "Air conditioning",
      "Flat-screen TV",
      "Balcony",
      "Kitchen",
      "Non-smoking",
      "Safe",
      "Coffee machine",
      "Minibar",
      "Laptop-friendly workspace",
    ],
    images: ["/vayada-logo.png"],
    bedType: "King bed",
    remainingRooms: 2,
    features: ["Free Cancellation", "Include Breakfast"],
    benefits: ["Best direct rate"],
    flexibleRateEnabled: true,
    cancellationPolicy: "free_until_7_days",
    flexibleCancellationType: "free",
    originalRate: null,
    lastMinuteDiscountPercent: null,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    locationMarkers: [],
  },
  {
    id: "garden-room",
    name: "Garden Room",
    category: "Double",
    description: "A quiet double room facing the garden.",
    shortDescription: "Quiet garden-facing double room.",
    maxOccupancy: 2,
    maxAdults: 2,
    maxChildren: 1,
    size: 24,
    baseRate: 160,
    nonRefundableRate: null,
    currency: "EUR",
    amenities: ["Wi-Fi"],
    images: ["/vayada-logo.png"],
    bedType: "Queen bed",
    remainingRooms: 0,
    features: [],
    benefits: [],
    flexibleRateEnabled: true,
    cancellationPolicy: "free_until_7_days",
    flexibleCancellationType: "free",
    originalRate: null,
    lastMinuteDiscountPercent: null,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    locationMarkers: [],
  },
];

const addons = [
  {
    id: "airport-transfer",
    name: "Airport Transfer",
    description: "Private arrival transfer to the hotel.",
    price: 45,
    currency: "EUR",
    category: "transport",
    image: "/vayada-logo.png",
    images: ["/vayada-logo.png"],
    duration: "45 minutes",
    perPerson: false,
    perNight: false,
    location: "Luggage claim",
    maxGuests: "4",
    highlights: ["Private pickup", "Flight tracking"],
    includedItems: ["Driver", "Luggage assistance"],
  },
];

// The legacy availability routes answer 410 like the real API does now (VAY-1543 C.2);
// booking-web must never request them. Specs assert on this through `legacyPricingRequests`.
export const PRICING_RETIRED = {
  status: 410,
  json: {
    statusCode: 410,
    code: "PRICING_RETIRED",
    message:
      "The old booking flow has been retired. Price and book through the room-and-price flow.",
  },
};

/** A one-room catalogue so the room-and-price page renders its form. */
export async function mockPricingCatalogue(page: Page) {
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "suite",
            name: "Suite",
            offers: [
              {
                publicOfferKey: `pricing-offer.v2:${"a".repeat(64)}`,
                currency: "EUR",
                mealPlan: "breakfast",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({ json: { version: "public-pricing-addons.v1", addons: [] } }),
  );
}

export function legacyPricingRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/booking-web\/hotels\/[^/]+\/(offers|calendar)(\?|$)/.test(request.url()))
      urls.push(request.url());
  });
  return urls;
}

type MockBookingApisOptions = {
  arrivalBounds?: { checkInUntil: string; checkOutFrom: string };
  supportedQuoteParameters?: Partial<typeof publicHotelProfile.hotel.supportedQuoteParameters>;
  supportedLocales?: string[];
  supportedCurrencies?: string[];
  headerLogoUrl?: string;
  headerSettings?: {
    showContactButton: boolean;
    showReferAGuestButton: boolean;
    showLanguageSelector: boolean;
    showCurrencySelector: boolean;
  };
  publicContacts?: typeof publicHotelProfile.hotel.publicContacts;
};

export async function mockBookingApis(page: Page, options: MockBookingApisOptions = {}) {
  const profile = {
    ...publicHotelProfile,
    hotel: {
      ...publicHotelProfile.hotel,
      ...(options.headerLogoUrl || options.headerSettings
        ? {
            branding: {
              logoUrl: options.headerLogoUrl ?? null,
              showContactButton: options.headerSettings?.showContactButton ?? true,
              showReferAGuestButton: options.headerSettings?.showReferAGuestButton ?? true,
              showLanguageSelector: options.headerSettings?.showLanguageSelector ?? true,
              showCurrencySelector: options.headerSettings?.showCurrencySelector ?? true,
              heroImage: null,
              heroHeading: null,
              heroSubtext: null,
              primaryColor: null,
              fontPairing: null,
            },
          }
        : {}),
      policies: { ...publicHotelProfile.hotel.policies, ...options.arrivalBounds },
      publicContacts: options.publicContacts ?? publicHotelProfile.hotel.publicContacts,
      supportedLocales: options.supportedLocales ?? publicHotelProfile.hotel.supportedLocales,
      supportedCurrencies:
        options.supportedCurrencies ?? publicHotelProfile.hotel.supportedCurrencies,
      supportedQuoteParameters: {
        ...publicHotelProfile.hotel.supportedQuoteParameters,
        ...options.supportedQuoteParameters,
      },
    },
  };
  await page.route("**/api/events", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/booking-web/events", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route(
    new RegExp(`/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}(?:\\\\?.*)?$`),
    async (route) => {
      await route.fulfill({ json: profile });
    },
  );

  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/attribution/clicks`,
    async (route) => {
      await route.fulfill({ status: 204, body: "" });
    },
  );

  for (const retired of ["offers", "calendar"]) {
    await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/${retired}**`, (route) =>
      route.fulfill(PRICING_RETIRED),
    );
  }

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}`, async (route) => {
    await route.fulfill({ json: hotel });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/rooms**`, async (route) => {
    await route.fulfill({ json: rooms });
  });

  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`,
    async (route) => {
      await route.fulfill({
        json: {
          addons,
          showAddonsStep: true,
          payAtPropertyEnabled: true,
          onlineCardPayment: false,
          freeCancellationDays: 7,
          phoneRequired: true,
        },
      });
    },
  );

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/addons`, async (route) => {
    await route.fulfill({ json: addons });
  });

  await page.route("**/api/exchange-rates**", async (route) => {
    await route.fulfill({ json: { base: "EUR", rates: { EUR: 1, USD: 1.1 } } });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/unavailable-dates**`, async (route) => {
    await route.fulfill({ json: { dates: [], min_stay_by_arrival: {} } });
  });
}
