import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_SLUG,
  BOOKING_ADMIN_ROOMS_PATH,
  BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
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

    await page.route(`**/api/hotels/${BOOKING_ADMIN_HOTEL_SLUG}/rooms`, (route) =>
      route.fulfill({
        json: [
          { id: "room-suite", name: "Alpine Suite" },
          { id: "room-deluxe", name: "Deluxe Room" },
        ],
      }),
    );
    await page.route(`**${BOOKING_ADMIN_ROOMS_PATH}`, (route) =>
      route.fulfill({
        json: {
          items: [
            { roomId: "room-suite", roomNumber: "Alpine Suite" },
            { roomId: "room-deluxe", roomNumber: "Deluxe Room" },
          ],
        },
      }),
    );

    const legacyWrites: unknown[] = [];
    await page.route("**/admin/settings/design", async (route) => {
      if (route.request().method() === "PATCH") {
        legacyWrites.push(route.request().postDataJSON());
      }

      await route.fulfill({
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
      });
    });

    await page.goto("/booking-flow");

    await expect(page.getByRole("heading", { name: "Room Filters" })).toBeVisible();
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
    expect(legacyWrites).toEqual([]);

    await assertHealthy();
  });
});
