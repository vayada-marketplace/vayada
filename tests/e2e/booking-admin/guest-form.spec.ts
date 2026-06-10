import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

const HOTEL_ID = "booking_hotel_alpenrose";
const ADDON_SETTINGS_CONTRACT_PATH = `/api/booking/hotels/${HOTEL_ID}/settings/addons`;
const GUEST_FORM_SETTINGS_CONTRACT_PATH = `/api/booking/hotels/${HOTEL_ID}/settings/guest-form`;

test.describe("booking-admin guest-form settings cutover", () => {
  test("loads guest-form toggles from the TypeScript contract and preserves legacy writes", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

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
    }, HOTEL_ID);

    await page.route("**/admin/module-activations", (route) =>
      route.fulfill({ json: { activations: [] } }),
    );
    await page.route("**/admin/hotels", (route) =>
      route.fulfill({ json: [{ id: HOTEL_ID, name: "Alpenrose", slug: "hotel-alpenrose" }] }),
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
    await page.route("**/admin/promo-codes", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/hotels/hotel-alpenrose/rooms", (route) => route.fulfill({ json: [] }));
    await page.route(`**${ADDON_SETTINGS_CONTRACT_PATH}*`, (route) =>
      route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: true },
      }),
    );

    const bookingSettingsWrites: unknown[] = [];
    await page.route("**/admin/settings/property", async (route) => {
      if (route.request().method() === "PATCH") {
        bookingSettingsWrites.push(route.request().postDataJSON());
        await route.fulfill({
          json: {
            id: HOTEL_ID,
            slug: "hotel-alpenrose",
            default_currency: "EUR",
            default_language: "en",
            supported_currencies: [],
            supported_languages: [],
            special_requests_enabled: true,
            arrival_time_enabled: true,
            guest_count_enabled: false,
          },
        });
        return;
      }

      await route.fulfill({
        json: {
          id: HOTEL_ID,
          slug: "hotel-alpenrose",
          default_currency: "EUR",
          default_language: "en",
          supported_currencies: [],
          supported_languages: [],
          special_requests_enabled: false,
          arrival_time_enabled: true,
          guest_count_enabled: true,
        },
      });
    });

    const contractRequests: string[] = [];
    await page.route(`**${GUEST_FORM_SETTINGS_CONTRACT_PATH}*`, async (route) => {
      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: {
          specialRequestsEnabled: true,
          arrivalTimeEnabled: false,
          guestCountEnabled: false,
        },
      });
    });

    const pmsSyncWrites: unknown[] = [];
    await page.route("**/admin/guest-form-settings", async (route) => {
      expect(route.request().method()).toBe("PATCH");
      pmsSyncWrites.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Guest Form$/ }).click();

    await expect(page.getByRole("heading", { name: "Guest Information Form" })).toBeVisible();

    const specialRequestsToggle = page.getByRole("button", { name: "Special Requests" });
    const arrivalTimeToggle = page.getByRole("button", { name: "Estimated Arrival Time" });
    const guestCountToggle = page.getByRole("button", { name: "Number of Guests" });

    await expect(specialRequestsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(arrivalTimeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(guestCountToggle).toHaveAttribute("aria-pressed", "false");

    await arrivalTimeToggle.click();
    await expect(arrivalTimeToggle).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: /^Save Changes$/ }).click();

    await expect.poll(() => bookingSettingsWrites.length).toBe(1);
    await expect.poll(() => pmsSyncWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(GUEST_FORM_SETTINGS_CONTRACT_PATH);
    expect(bookingSettingsWrites).toEqual([
      {
        special_requests_enabled: true,
        arrival_time_enabled: true,
        guest_count_enabled: false,
      },
    ]);
    expect(pmsSyncWrites).toEqual([
      {
        special_requests_enabled: true,
        arrival_time_enabled: true,
        guest_count_enabled: false,
      },
    ]);

    await assertHealthy();
  });
});
