import type { Page } from "@playwright/test";

export const BOOKING_ADMIN_HOTEL_ID = "booking_hotel_alpenrose";
export const BOOKING_ADMIN_HOTEL_SLUG = "hotel-alpenrose";
export const BOOKING_ADMIN_ADDON_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/addons`;
export const BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/guest-form`;

export interface BookingAdminPropertySettingsFixture {
  id: string;
  slug: string;
  default_currency: string;
  default_language: string;
  supported_currencies: string[];
  supported_languages: string[];
  special_requests_enabled: boolean;
  arrival_time_enabled: boolean;
  guest_count_enabled: boolean;
}

export interface BookingAdminAddonSettingsFixture {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export interface BookingAdminGuestFormSettingsFixture {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
}

export interface BookingAdminShellMocksOptions {
  propertySettings?: BookingAdminPropertySettingsFixture;
}

export interface BookingAdminBookingFlowMocksOptions {
  addonSettings?: BookingAdminAddonSettingsFixture;
  guestFormSettings?: BookingAdminGuestFormSettingsFixture;
}

export const defaultBookingAdminPropertySettings: BookingAdminPropertySettingsFixture = {
  id: BOOKING_ADMIN_HOTEL_ID,
  slug: BOOKING_ADMIN_HOTEL_SLUG,
  default_currency: "EUR",
  default_language: "en",
  supported_currencies: [],
  supported_languages: [],
  special_requests_enabled: false,
  arrival_time_enabled: false,
  guest_count_enabled: false,
};

const defaultAddonSettings: BookingAdminAddonSettingsFixture = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const defaultGuestFormSettings: BookingAdminGuestFormSettingsFixture = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
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
  await page.route("**/admin/addons", (route) => route.fulfill({ json: [] }));
  await page.route("**/admin/settings/design", (route) =>
    route.fulfill({
      json: {
        hero_image: "",
        hero_heading: "",
        hero_subtext: "",
        primary_color: "",
        font_pairing: "",
        booking_filters: [],
        custom_filters: {},
        filter_rooms: {},
      },
    }),
  );
  await page.route("**/admin/benefits", (route) => route.fulfill({ json: { benefits: [] } }));
  await page.route("**/admin/settings/property", (route) =>
    route.fulfill({ json: propertySettings }),
  );
  await page.route("**/admin/promo-codes", (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/hotels/${BOOKING_ADMIN_HOTEL_SLUG}/rooms`, (route) =>
    route.fulfill({ json: [] }),
  );
}

export async function mockBookingAdminBookingFlow(
  page: Page,
  options: BookingAdminBookingFlowMocksOptions = {},
): Promise<void> {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.addonSettings ?? defaultAddonSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.guestFormSettings ?? defaultGuestFormSettings }),
  );
}
