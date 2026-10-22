import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

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
}

test("old Settings links open the card page that holds them now", async ({ page }) => {
  await mockSettings(page);
  for (const [legacy, target] of [
    ["/settings#property-details", "/settings/property"],
    ["/settings#language", "/settings/property#language"],
    ["/settings#currency", "/settings/property#currency"],
    ["/settings#ota-commissions", "/settings/ota-commissions"],
    ["/settings/checkin-checklist", "/settings/guest-flows#check-in"],
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
  // Six check-in steps arriving late push the check-out section below the fold.
  await mockSettings(page, { checkInSteps: 6, checkInDelayMs: 500 });
  await page.goto("/settings/checkout-inspection");
  await expect(page.locator("#check-in").getByText("Step 6", { exact: true })).toBeAttached();
  await expect(page.locator("#check-out h2")).toBeInViewport();

  await page.goto("/settings#language");
  await expect(page).toHaveURL(/\/settings\/property#language$/);
  await expect(page.getByRole("button", { name: /English/ })).toBeInViewport();
});

test("Guest flows holds the check-in and check-out editors, each with its own Save", async ({
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
  for (const [section, heading] of [
    ["#check-in", "Check-in"],
    ["#check-out", "Check-out"],
  ]) {
    const flow = page.locator(section);
    await expect(flow.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expect(flow.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(flow.getByRole("link", { name: "Preview" })).toBeVisible();
  }
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
    for (const route of ["/settings", "/settings/property", "/settings/guest-flows"]) {
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
