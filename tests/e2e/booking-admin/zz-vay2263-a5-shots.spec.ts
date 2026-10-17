import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminDesignSettings,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// VAY-2263 A5 evidence: before/after screenshots of the affiliate / Refer-a-Guest surface.
// Untracked helper spec; run with E2E_SHOT_TAG=before|after.
const tag = process.env.E2E_SHOT_TAG ?? "shot";

async function setup(page: Page) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await mockBookingAdminDesignSettings(page);
  await page.route("**/api/pms/properties/*/module-activations", (route) =>
    route.fulfill({
      json: {
        hotelId: BOOKING_ADMIN_PROPERTY_ID,
        canManage: true,
        supportedModules: ["affiliates"],
        activeModules: ["affiliates"],
        activations: [{ moduleId: "affiliates", isActive: true }],
      },
    }),
  );
}

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(500);
  const height = await page.evaluate(() => {
    let max = document.documentElement.scrollHeight;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const style = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight && style.overflowY !== "visible")
        max = Math.max(max, el.scrollHeight + el.getBoundingClientRect().top);
    }
    return Math.ceil(max);
  });
  await page.setViewportSize({ width: 1280, height: Math.min(Math.max(900, height), 4000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `test-results/vay2263-a5/${name}-${tag}.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.use({ viewport: { width: 1280, height: 900 } });

test(`feature hub (${tag})`, async ({ page }) => {
  await setup(page);
  await page.goto("/settings/feature-hub");
  await expect(page.locator("article").first()).toBeVisible();
  await shoot(page, "booking-admin-feature-hub");
});

test(`design studio media tab (${tag})`, async ({ page }) => {
  await setup(page);
  await page.goto("/design-studio");
  await expect(page.getByRole("switch", { name: "Contact button" })).toBeVisible();
  await shoot(page, "booking-admin-design-studio-media");
});

test(`affiliates page (${tag})`, async ({ page }) => {
  await setup(page);
  await page.goto("/affiliates");
  await page.waitForLoadState("networkidle");
  await shoot(page, "booking-admin-affiliates");
});
