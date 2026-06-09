import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

const HOTEL_ID = "booking_hotel_alpenrose";
const ADDON_SETTINGS_CONTRACT_PATH = `/api/booking/hotels/${HOTEL_ID}/settings/addons`;

test.describe("booking-admin add-ons settings cutover", () => {
  test("loads display settings from the TypeScript contract and preserves legacy writes", async ({
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

    await page.route("**/admin/**", (route) => route.fulfill({ json: {} }));
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
    await page.route("**/admin/settings/property", (route) =>
      route.fulfill({
        json: {
          id: HOTEL_ID,
          slug: "hotel-alpenrose",
          default_currency: "EUR",
          default_language: "en",
          supported_currencies: [],
          supported_languages: [],
          special_requests_enabled: false,
          arrival_time_enabled: false,
          guest_count_enabled: false,
        },
      }),
    );
    await page.route("**/admin/promo-codes", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/hotels/hotel-alpenrose/rooms", (route) => route.fulfill({ json: [] }));

    const contractRequests: string[] = [];
    await page.route(`**${ADDON_SETTINGS_CONTRACT_PATH}*`, async (route) => {
      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: false },
      });
    });

    const legacyWrites: string[] = [];
    await page.route("**/admin/settings/addons", async (route) => {
      legacyWrites.push(route.request().postData() ?? "");
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().postDataJSON()).toEqual({ groupAddonsByCategory: true });
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: true },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Add-ons$/ }).click();

    await expect(page.getByRole("heading", { name: "Display Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Show Add-ons Step/ })).toBeVisible();

    const groupToggle = page.getByRole("button", { name: /Group by Category/ });
    await expect(groupToggle).toBeVisible();
    await groupToggle.click();

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(ADDON_SETTINGS_CONTRACT_PATH);
    expect(legacyWrites).toEqual([JSON.stringify({ groupAddonsByCategory: true })]);

    await assertHealthy();
  });
});
