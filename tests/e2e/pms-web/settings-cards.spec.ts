import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { checkinSettingsResponse } from "../support/checkinSettingsMocks";

// VAY-2275: PMS Settings is the Booking Admin card grid; each card opens its own page.

async function mockSettings(page: Page, { checkInSteps = 0, checkInDelayMs = 0 } = {}) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const template = (steps: unknown[]) => ({
    contractVersion: "pms-operations.v1",
    propertyId: PMS_WEB_PROPERTY_ID,
    template: { steps, updatedAt: null, updatedByUserId: null },
    sourceFreshness: {},
  });
  const checkIn = Array.from({ length: checkInSteps }, (_, index) => ({
    id: `step-${index}`,
    label: `Step ${index + 1}`,
    prompt: "Something staff check at arrival.",
    type: "checkbox",
    required: false,
    system: false,
    position: index,
  }));
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-checklist`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, checkInDelayMs));
      await route.fulfill({ json: template(checkIn) });
    },
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-out-inspection`, (route) =>
    route.fulfill({ json: template([]) }),
  );
  // Settings → Check-in (VAY-2374): its settings and the add-on catalog load with the checklist.
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-settings`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, checkInDelayMs));
      await route.fulfill({ json: checkinSettingsResponse() });
    },
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/manual-bookings/addons`, (route) =>
    route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: [] } }),
  );
}

test("old Settings links open the card page that holds them now", async ({ page }) => {
  await mockSettings(page);
  for (const [legacy, target] of [
    ["/settings#property-details", "/settings/property"],
    ["/settings#language", "/settings/property#language"],
    ["/settings#currency", "/settings/property#currency"],
    ["/settings#ota-commissions", "/settings/ota-commissions"],
    ["/settings/checkin-checklist", "/settings/check-in#extra-checks"],
    ["/settings/checkout-inspection", "/settings/guest-flows#check-out"],
  ]) {
    await page.goto(legacy);
    await expect(page).toHaveURL(new URL(target, page.url()).toString());
    await expect(page.locator("main h1")).toBeVisible();
  }
  await page.goto("/settings#unknown");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("a link to a lower section still lands on it after the sections above it load", async ({
  page,
}) => {
  // The check-in settings arrive late and push the extra checks far down the page.
  await mockSettings(page, { checkInSteps: 6, checkInDelayMs: 500 });
  await page.goto("/settings/checkin-checklist");
  await expect(page).toHaveURL(/\/settings\/check-in#extra-checks$/);
  await expect(page.locator("#keys-and-check-in").getByRole("textbox").nth(5)).toHaveValue(
    "Step 6",
  );
  await expect(page.locator("#extra-checks")).toBeInViewport();

  await page.goto("/settings#language");
  await expect(page).toHaveURL(/\/settings\/property#language$/);
  await expect(page.getByRole("button", { name: /English/ })).toBeInViewport();
});

test("Guest flows holds the check-out inspection; the check-in has its own card", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockSettings(page);
  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Guest flows/ })
    .click();

  await expect(page).toHaveURL(/\/settings\/guest-flows$/);
  await expect(page.getByRole("heading", { level: 1, name: "Guest flows" })).toBeVisible();
  const checkOut = page.locator("#check-out");
  await expect(checkOut.getByRole("heading", { level: 2, name: "Check-out" })).toBeVisible();
  await expect(checkOut.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(checkOut.getByRole("link", { name: "Preview" })).toBeVisible();
  await expect(page.locator("#check-in")).toHaveCount(0);

  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Check-in/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/check-in$/);
  await expect(page.getByRole("heading", { level: 1, name: "Check-in" })).toBeVisible();
  await assertHealthy();
});

for (const [width, height, label] of [
  [1440, 900, "1440"],
  [390, 844, "390"],
] as const) {
  test(`Settings card pages at ${label}`, async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height });
    await mockSettings(page);
    for (const route of [
      "/settings",
      "/settings/property",
      "/settings/guest-flows",
      "/settings/check-in",
    ]) {
      await page.goto(route);
      await expect(page.locator("main h1")).toBeVisible();
      await page.waitForLoadState("networkidle");
      // No page scrolls sideways on a phone.
      const overflow = await page
        .locator("main")
        .evaluate((main) => main.scrollWidth - main.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(0);
      await testInfo.attach(`${route.slice(1).replaceAll("/", "-")}-${label}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    await assertHealthy();
  });
}
