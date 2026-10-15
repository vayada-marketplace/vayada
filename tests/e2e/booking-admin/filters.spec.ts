import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ROOMS_PATH,
  BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin room-filter settings cutover", () => {
  test("loads and saves room filters through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await mockBookingAdminBookingFlow(page);

    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH}*`, async (route) => {
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
          bookingFilters: ["includeBreakfast", "rooftop"],
          customFilters: { rooftop: "Rooftop Terrace" },
          filterRooms: {
            includeBreakfast: ["room-suite"],
            rooftop: ["room-suite", "room-deluxe"],
          },
        },
      });
    });

    await page.route(`**${BOOKING_ADMIN_ROOMS_PATH}*`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: BOOKING_ADMIN_HOTEL_ID,
          items: [
            { roomId: "room-suite", roomNumber: "Alpine Suite" },
            { roomId: "room-deluxe", roomNumber: "Deluxe Room" },
          ],
          sourceFreshness: {},
        },
      }),
    );

    // Room Filters moved from Booking Flow to Settings (VAY-2144); old links still land there.
    for (const legacy of ["/booking-flow", "/booking-flow?tab=rooms"]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(/\/settings\/room-filters$/);
    }
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(breadcrumb.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    await expect(page.getByRole("heading", { name: "Room Filters", level: 1 })).toBeVisible();
    await expect(page.getByText("Include Breakfast")).toBeVisible();
    await expect(page.getByText("Rooftop Terrace")).toBeVisible();
    await expect(page.getByText("Alpine Suite").first()).toBeVisible();
    await expect(page.getByText("Deluxe Room").first()).toBeVisible();

    await page.getByRole("button", { name: /^Save Filters$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        bookingFilters: ["includeBreakfast", "rooftop"],
        customFilters: { rooftop: "Rooftop Terrace" },
        filterRooms: {
          includeBreakfast: ["room-suite"],
          rooftop: ["room-suite", "room-deluxe"],
        },
      },
    ]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("shows Retry instead of empty filters when the read fails", async ({ page }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminBookingFlow(page);
    let failRead = true;
    await page.route(`**${BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH}*`, async (route) => {
      if (failRead) {
        failRead = false;
        await route.fulfill({ status: 503, json: { message: "Unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          bookingFilters: ["rooftop"],
          customFilters: { rooftop: "Rooftop Terrace" },
          filterRooms: { rooftop: ["room-suite"] },
        },
      });
    });

    await page.goto("/settings/room-filters");
    // "Filters off" after a failed read would let a Save wipe the real filters.
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to load settings" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save Filters$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Rooftop Terrace")).toBeVisible();
  });
});
