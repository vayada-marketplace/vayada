import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2263 A5 evidence: before/after screenshot of the PMS Feature Hub.
// Untracked helper spec; run with E2E_SHOT_TAG=before|after.
const tag = process.env.E2E_SHOT_TAG ?? "shot";

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

test(`pms feature hub (${tag})`, async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations*`, (route) =>
    route.fulfill({
      json: {
        hotelId: PMS_WEB_PROPERTY_ID,
        canManage: true,
        supportedModules: ["affiliates"],
        activeModules: ["affiliates"],
        activations: [{ moduleId: "affiliates", isActive: true }],
      },
    }),
  );
  await page.goto("/settings/feature-hub");
  await expect(page.locator("article").first()).toBeVisible();
  await shoot(page, "pms-feature-hub");
});
