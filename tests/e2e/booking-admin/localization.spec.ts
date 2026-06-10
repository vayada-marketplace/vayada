import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_HOTEL_SLUG,
  BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin localization settings cutover", () => {
  test("loads and saves localization settings through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

    await mockBookingAdminBookingFlow(page);

    const legacyWrites: unknown[] = [];
    await page.route("**/admin/settings/property", async (route) => {
      if (route.request().method() === "PATCH") {
        legacyWrites.push(route.request().postDataJSON());
        await route.fulfill({
          json: {
            id: BOOKING_ADMIN_HOTEL_ID,
            slug: BOOKING_ADMIN_HOTEL_SLUG,
            default_currency: "CHF",
            default_language: "de",
            supported_currencies: ["EUR", "USD"],
            supported_languages: ["en", "fr"],
            special_requests_enabled: false,
            arrival_time_enabled: true,
            guest_count_enabled: true,
          },
        });
        return;
      }

      await route.fulfill({
        json: {
          id: BOOKING_ADMIN_HOTEL_ID,
          slug: BOOKING_ADMIN_HOTEL_SLUG,
          default_currency: "EUR",
          default_language: "en",
          supported_currencies: [],
          supported_languages: [],
          special_requests_enabled: false,
          arrival_time_enabled: false,
          guest_count_enabled: false,
        },
      });
    });

    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: {
          defaultCurrency: "CHF",
          defaultLanguage: "de",
          supportedCurrencies: ["EUR", "USD"],
          supportedLanguages: ["en", "fr"],
        },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Localization$/ }).click();

    await expect(page.getByRole("heading", { name: "Currency & Languages" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Swiss Franc/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /German/ })).toBeVisible();
    await expect(page.getByText("Added (2):").first()).toBeVisible();
    await expect(page.getByText("EUR").first()).toBeVisible();
    await expect(page.getByText("USD").first()).toBeVisible();
    await expect(page.getByText("English").first()).toBeVisible();
    await expect(page.getByText(/Fran/).first()).toBeVisible();

    await page.getByRole("button", { name: /^Save Changes$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        defaultCurrency: "CHF",
        defaultLanguage: "de",
        supportedCurrencies: ["EUR", "USD"],
        supportedLanguages: ["en", "fr"],
      },
    ]);
    expect(legacyWrites).toEqual([]);

    await assertHealthy();
  });
});
