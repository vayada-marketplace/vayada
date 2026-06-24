import type { Page } from "@playwright/test";

export const SEEDED_BOOKING_SLUG = "hotel-alpenrose";

const hotel = {
  id: "hotel-alpenrose-id",
  name: "Hotel Alpenrose",
  slug: SEEDED_BOOKING_SLUG,
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
  supportedLanguages: ["en", "de"],
  referAGuestEnabled: true,
  instantBook: true,
  mapViewEnabled: false,
  showRoomDetailMap: true,
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
    amenities: ["Free WiFi", "Breakfast", "Balcony"],
    images: ["/vayada-logo.png", "/vayada-logo.png"],
    bedType: "King bed",
    remainingRooms: 3,
    features: ["Free Cancellation", "Include Breakfast"],
    benefits: ["Best direct rate"],
    flexibleRateEnabled: true,
    cancellationPolicy: "free_until_7_days",
    flexibleCancellationType: "free",
    originalRate: null,
    lastMinuteDiscountPercent: null,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    latitude: 46.0207,
    longitude: 7.7491,
    locationMarkers: [],
  },
];

interface BookingApiMockOptions {
  paymentSettings?: Record<string, unknown>;
}

export async function mockBookingApis(page: Page, options: BookingApiMockOptions = {}) {
  await page.route("**/api/events", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}`, async (route) => {
    await route.fulfill({ json: hotel });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/rooms**`, async (route) => {
    await route.fulfill({ json: rooms });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/addons`, async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/payment-settings`, async (route) => {
    await route.fulfill({
      json: {
        payAtPropertyEnabled: true,
        payAtHotelMethods: ["cash", "card"],
        onlineCardPayment: false,
        bankTransfer: false,
        paypalEnabled: false,
        freeCancellationDays: 7,
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: false,
        phoneRequired: true,
        termsText: "",
        cancellationPolicyText: "",
        ...options.paymentSettings,
      },
    });
  });

  await page.route("**/api/exchange-rates**", async (route) => {
    await route.fulfill({ json: { base: "EUR", rates: { EUR: 1, USD: 1.1 } } });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/unavailable-dates**`, async (route) => {
    await route.fulfill({ json: { dates: [], min_stay_by_arrival: {} } });
  });
}
