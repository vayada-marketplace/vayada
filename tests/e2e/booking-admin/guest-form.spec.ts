import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_HOTEL_SLUG,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin guest-form settings cutover", () => {
  test("loads and saves guest-form toggles through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

    await mockBookingAdminBookingFlow(page);

    const bookingSettingsWrites: unknown[] = [];
    await page.route("**/admin/settings/property", async (route) => {
      if (route.request().method() === "PATCH") {
        bookingSettingsWrites.push(route.request().postDataJSON());
        await route.fulfill({
          json: {
            id: BOOKING_ADMIN_HOTEL_ID,
            slug: BOOKING_ADMIN_HOTEL_SLUG,
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
          id: BOOKING_ADMIN_HOTEL_ID,
          slug: BOOKING_ADMIN_HOTEL_SLUG,
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
    const typedWrites: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH}*`, async (route) => {
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

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: true,
        guestCountEnabled: false,
      },
    ]);
    expect(bookingSettingsWrites).toEqual([]);
    expect(pmsSyncWrites).toEqual([]);

    await assertHealthy();
  });
});
