import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_HOTEL_SLUG,
  mockBookingAdminAuthenticatedSession,
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
          adultAgeThreshold: 18,
          childrenEnabled: true,
        },
      });
    });

    const pmsSyncWrites: unknown[] = [];
    await page.route("**/admin/guest-form-settings", async (route) => {
      expect(route.request().method()).toBe("PATCH");
      pmsSyncWrites.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });

    // Guest Form moved from Booking Flow to Settings (VAY-2144); old tab links still land there.
    await page.goto("/booking-flow?tab=guest-form");
    await expect(page).toHaveURL(/\/settings\/guest-form$/);
    await expect(page.getByRole("heading", { name: "Guest Form", level: 1 })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Guest Information Form" })).toBeVisible();

    const specialRequestsToggle = page.getByRole("button", { name: "Special Requests" });
    const arrivalTimeToggle = page.getByRole("button", { name: "Estimated Arrival Time" });
    const guestCountToggle = page.getByRole("button", { name: "Number of Guests" });
    const childrenToggle = page.getByRole("button", { name: "Children" });
    const adultAgeInput = page.getByRole("spinbutton", { name: "Adult age threshold" });

    await expect(specialRequestsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(arrivalTimeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(guestCountToggle).toHaveAttribute("aria-pressed", "false");
    await expect(childrenToggle).toHaveAttribute("aria-pressed", "true");
    await expect(adultAgeInput).toHaveValue("18");

    await arrivalTimeToggle.click();
    await expect(arrivalTimeToggle).toHaveAttribute("aria-pressed", "true");
    await childrenToggle.click();
    await expect(childrenToggle).toHaveAttribute("aria-pressed", "false");
    await adultAgeInput.fill("21");

    await page.getByRole("button", { name: /^Save Changes$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: true,
        guestCountEnabled: false,
        adultAgeThreshold: 21,
        childrenEnabled: false,
      },
    ]);
    expect(bookingSettingsWrites).toEqual([]);
    expect(pmsSyncWrites).toEqual([]);

    await assertHealthy();
  });

  test("shows Retry instead of default fields when the read fails", async ({ page }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminBookingFlow(page);
    let failRead = true;
    await page.route(`**${BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH}*`, async (route) => {
      if (failRead) {
        failRead = false;
        await route.fulfill({ status: 503, json: { message: "Unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          specialRequestsEnabled: false,
          arrivalTimeEnabled: true,
          guestCountEnabled: false,
          adultAgeThreshold: 16,
          childrenEnabled: true,
        },
      });
    });

    await page.goto("/settings/guest-form");
    // The defaults after a failed read would let a Save overwrite the real form.
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to load settings" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save Changes$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Adult age threshold" })).toHaveValue("16");
  });

  test("keeps the hotel picked in the header when an older hotel's form arrives late", async ({
    page,
  }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const secondHotelId = "booking_hotel_seeblick";
    await mockBookingAdminBookingFlow(page);
    await mockBookingAdminAuthenticatedSession(page, [BOOKING_ADMIN_HOTEL_ID, secondHotelId]);
    let releaseFirstHotel = () => {};
    const firstHotelHeld = new Promise<void>((resolve) => {
      releaseFirstHotel = resolve;
    });
    const form = (adultAgeThreshold: number) => ({
      specialRequestsEnabled: true,
      arrivalTimeEnabled: false,
      guestCountEnabled: false,
      adultAgeThreshold,
      childrenEnabled: true,
    });
    const writes: string[] = [];
    await page.route("**/api/booking/hotels/*/settings/guest-form*", async (route) => {
      const hotelId = new URL(route.request().url()).pathname.split("/")[4]!;
      if (route.request().method() === "PUT") {
        writes.push(hotelId);
        await route.fulfill({ json: route.request().postDataJSON() });
        return;
      }
      if (hotelId === BOOKING_ADMIN_HOTEL_ID) {
        await firstHotelHeld;
        await route.fulfill({ json: form(16) });
        return;
      }
      await route.fulfill({ json: form(21) });
    });

    const firstHotelRequested = page.waitForRequest((request) =>
      request.url().includes(`/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/guest-form`),
    );
    await page.goto("/settings/guest-form");
    await firstHotelRequested;
    // The header stores the new hotel and announces it (SELECTED_HOTEL_CHANGED_EVENT).
    await page.evaluate((hotelId) => {
      localStorage.setItem("selectedHotelId", hotelId);
      window.dispatchEvent(new Event("booking-admin:selected-hotel-changed"));
    }, secondHotelId);
    const adultAge = page.getByRole("spinbutton", { name: "Adult age threshold" });
    await expect(adultAge).toHaveValue("21");

    const lateAnswer = page.waitForResponse((response) =>
      response.url().includes(`/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/guest-form`),
    );
    releaseFirstHotel();
    await lateAnswer;
    // Give a stale answer the chance to land before checking it didn't.
    await page.waitForTimeout(300);
    await expect(adultAge).toHaveValue("21");
    await page.getByRole("button", { name: /^Save Changes$/ }).click();
    await expect.poll(() => writes).toEqual([secondHotelId]);
  });
});
