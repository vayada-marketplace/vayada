import type { Page } from "@playwright/test";

export const BOOKING_ADMIN_HOTEL_ID = "booking_hotel_alpenrose";
export const BOOKING_ADMIN_PROPERTY_ID = "f6853000-0000-0000-0000-000000000001";
export const BOOKING_ADMIN_HOTEL_SLUG = "hotel-alpenrose";
export const BOOKING_ADMIN_ROOMS_PATH = `/api/pms/properties/${BOOKING_ADMIN_HOTEL_ID}/rooms`;
export const BOOKING_ADMIN_ADDON_ITEMS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/addon-items`;
export const BOOKING_ADMIN_PROPERTY_LINK_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/property-link`;
export const BOOKING_ADMIN_ADDON_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/addons`;
export const BOOKING_ADMIN_BENEFITS_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/benefits`;
export const BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/guest-form`;
export const BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/localization`;
export const BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/room-filters`;
export const BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/payment-settings`;

export interface BookingAdminPropertySettingsFixture {
  id: string;
  slug: string;
  default_currency: string;
  default_language: string;
  supported_currencies: string[];
  supported_languages: string[];
  pay_at_hotel_methods: string[];
  special_requests_enabled: boolean;
  arrival_time_enabled: boolean;
  guest_count_enabled: boolean;
}

export interface BookingAdminAddonSettingsFixture {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export interface BookingAdminAddonItemsFixture {
  addonItems: Array<{
    addonItemId: string;
    hotelId: string;
    propertyId: string;
    name: string;
    description: string;
    price: string;
    currency: string;
    category: string;
    imageUrl: string | null;
    duration: string | null;
    pricingModel: string;
    publicVisible: boolean;
    status: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface BookingAdminBenefitsSettingsFixture {
  benefits: string[];
}

export interface BookingAdminGuestFormSettingsFixture {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
}

export interface BookingAdminLocalizationSettingsFixture {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
}

export interface BookingAdminRoomFilterSettingsFixture {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
}

export interface BookingAdminShellMocksOptions {
  propertySettings?: BookingAdminPropertySettingsFixture;
}

export interface BookingAdminBookingFlowMocksOptions {
  addonItems?: BookingAdminAddonItemsFixture;
  addonSettings?: BookingAdminAddonSettingsFixture;
  benefitsSettings?: BookingAdminBenefitsSettingsFixture;
  guestFormSettings?: BookingAdminGuestFormSettingsFixture;
  localizationSettings?: BookingAdminLocalizationSettingsFixture;
  roomFilterSettings?: BookingAdminRoomFilterSettingsFixture;
}

export const defaultBookingAdminPropertySettings: BookingAdminPropertySettingsFixture = {
  id: BOOKING_ADMIN_HOTEL_ID,
  slug: BOOKING_ADMIN_HOTEL_SLUG,
  default_currency: "EUR",
  default_language: "en",
  supported_currencies: [],
  supported_languages: [],
  pay_at_hotel_methods: ["cash", "card"],
  special_requests_enabled: false,
  arrival_time_enabled: false,
  guest_count_enabled: false,
};

const defaultAddonSettings: BookingAdminAddonSettingsFixture = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const defaultAddonItems: BookingAdminAddonItemsFixture = {
  addonItems: [
    {
      addonItemId: "addon_airport_transfer",
      hotelId: BOOKING_ADMIN_HOTEL_ID,
      propertyId: "property_alpenrose",
      name: "Airport transfer",
      description: "Private pickup from the airport.",
      price: "45.00",
      currency: "EUR",
      category: "transport",
      imageUrl: null,
      duration: "45 min",
      pricingModel: "per_stay",
      publicVisible: true,
      status: "active",
      sortOrder: 0,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    },
  ],
};

const defaultBenefitsSettings: BookingAdminBenefitsSettingsFixture = {
  benefits: [],
};

const defaultGuestFormSettings: BookingAdminGuestFormSettingsFixture = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
};

const defaultLocalizationSettings: BookingAdminLocalizationSettingsFixture = {
  defaultCurrency: "EUR",
  defaultLanguage: "en",
  supportedCurrencies: [],
  supportedLanguages: [],
};

const defaultRoomFilterSettings: BookingAdminRoomFilterSettingsFixture = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

export async function mockBookingAdminAuthenticatedSession(page: Page): Promise<void> {
  await page.addInitScript((hotelId) => {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    window.localStorage.setItem("access_token", "e2e-booking-admin-token");
    window.localStorage.setItem("token_expires_at", String(oneHourFromNow));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userType", "hotel");
    window.localStorage.setItem("isSuperAdmin", "false");
    window.localStorage.setItem("selectedHotelId", hotelId);
    window.localStorage.setItem(
      "user",
      JSON.stringify({ id: "user_1", email: "owner@example.com", type: "hotel" }),
    );
  }, BOOKING_ADMIN_HOTEL_ID);
}

export async function mockBookingAdminShellRoutes(
  page: Page,
  options: BookingAdminShellMocksOptions = {},
): Promise<void> {
  const propertySettings = options.propertySettings ?? defaultBookingAdminPropertySettings;
  // Register broad fallback first; Playwright lets later, more specific routes
  // win. This fallback is intentionally non-contractual shell noise; specs
  // still assert the product contract routes they own.
  await page.route("**/admin/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/admin/module-activations", (route) =>
    route.fulfill({ json: { activations: [] } }),
  );
  await page.route("**/admin/hotels", (route) =>
    route.fulfill({
      json: [
        {
          id: BOOKING_ADMIN_HOTEL_ID,
          name: "Alpenrose",
          slug: BOOKING_ADMIN_HOTEL_SLUG,
        },
      ],
    }),
  );
  await page.route("**/admin/superadmin/hotels", (route) => route.fulfill({ json: [] }));
  await page.route("**/admin/settings/property", (route) =>
    route.fulfill({ json: propertySettings }),
  );
  await page.route(`**${BOOKING_ADMIN_PROPERTY_LINK_PATH}*`, (route) =>
    route.fulfill({
      json: {
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        resourceLinks: {
          bookingHotel: true,
          pmsProperty: true,
          financeProperty: true,
        },
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_ROOMS_PATH}*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: BOOKING_ADMIN_HOTEL_ID,
        items: [],
        sourceFreshness: {},
      },
    }),
  );
}

export async function mockBookingAdminBookingFlow(
  page: Page,
  options: BookingAdminBookingFlowMocksOptions = {},
): Promise<void> {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, (route) =>
    route.fulfill({ json: options.addonItems ?? defaultAddonItems }),
  );
  await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.addonSettings ?? defaultAddonSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_BENEFITS_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.benefitsSettings ?? defaultBenefitsSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.guestFormSettings ?? defaultGuestFormSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.localizationSettings ?? defaultLocalizationSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.roomFilterSettings ?? defaultRoomFilterSettings }),
  );
}
