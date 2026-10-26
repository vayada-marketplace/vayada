import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2131: the room photo limit message and upgrade link show only once the room is full.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const photos = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    name: `room-${from + i}.png`,
    mimeType: "image/png",
    buffer: PNG,
  }));
const main = (page: Page) => page.locator("main");

async function openNewRoomImages(
  page: Page,
  plan?: { plan: string; maxRoomPhotosPerType: number },
) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  if (plan)
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/plan-limits`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          propertyPlan: {
            propertyId: PMS_WEB_PROPERTY_ID,
            plan: plan.plan,
            limits: {
              maxRoomPhotosPerType: plan.maxRoomPhotosPerType,
              maxAddons: 9,
              guestContactAccess: "always",
            },
          },
        },
      }),
    );
  await page.goto("/rooms/new");
  await main(page).getByRole("button", { name: "Images & Amenities" }).click();
}

test("a commission room shows only the counter until a pick fills it", async ({ page }) => {
  await openNewRoomImages(page);
  await expect(main(page).getByText("0/10 photos", { exact: true })).toBeVisible();
  await expect(main(page).getByText(/upgrade|photo limit/i)).toHaveCount(0);

  await main(page).locator('input[type="file"]').setInputFiles(photos(12));
  await expect(main(page).getByText("10/10 photos", { exact: true })).toBeVisible();
  await expect(
    main(page).getByText(
      "Added 10 of 12 photos. A room can have up to 10 photos, so the rest were skipped.",
    ),
  ).toBeVisible();
  await expect(main(page).getByText("You've reached the 10-photo limit.")).toBeVisible();
  await expect(
    main(page).getByRole("link", {
      name: "Upgrade to the paid plan for up to 15 photos per room.",
    }),
  ).toHaveAttribute("href", /\/settings\?section=billing$/);
  await expect(main(page).locator('input[type="file"]')).toHaveCount(0);

  await main(page).getByRole("button", { name: "Remove room image 1", exact: true }).click();
  await expect(main(page).getByText("9/10 photos", { exact: true })).toBeVisible();
  await expect(main(page).getByText(/upgrade|photo limit|skipped/i)).toHaveCount(0);
  await expect(main(page).getByText("Add more images")).toBeVisible();
});

test("a paid room has no upgrade link, also when full", async ({ page }) => {
  await openNewRoomImages(page, { plan: "fixed", maxRoomPhotosPerType: 15 });
  await main(page).locator('input[type="file"]').setInputFiles(photos(8));
  await expect(main(page).getByText("8/15 photos", { exact: true })).toBeVisible();
  await expect(main(page).getByText(/upgrade|photo limit|skipped/i)).toHaveCount(0);

  await main(page).locator('input[type="file"]').setInputFiles(photos(9, 8));
  await expect(main(page).getByText("15/15 photos", { exact: true })).toBeVisible();
  await expect(main(page).getByText("Added 7 of 9 photos.", { exact: false })).toBeVisible();
  await expect(
    main(page).getByText("You've reached the 15-photo limit for the paid plan."),
  ).toBeVisible();
  await expect(main(page).getByRole("link", { name: /upgrade/i })).toHaveCount(0);
});
