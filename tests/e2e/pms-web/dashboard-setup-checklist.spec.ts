import { expect, test } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { goLiveChecklistFacts, mockSetupChecklist } from "../support/setupChecklistMocks";

// VAY-2247 wave 2, VAY-2451: the go-live cards on the PMS dashboard, shown only where the server offers them.
const EXIT_URL = `/dashboard?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
});

test("keeps today's amber banner while the checklist API isn't mounted (404)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.goto(EXIT_URL);

  const banner = page.getByRole("status").filter({ hasText: "Your property setup isn't complete" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
    "href",
    `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${PMS_WEB_PROPERTY_ID}`,
  );
  await expect(page.getByText(/Finish setting up/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-checklist-unavailable.png") });
  await assertHealthy();
});

test("shows the go-live list instead of the banner once the server answers", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  // Setup is finished, the room still has the first run's placeholder price.
  await mockSetupChecklist(page, {
    ...goLiveChecklistFacts(PMS_WEB_PROPERTY_ID),
    placeholderPrices: true,
  });
  await page.goto(EXIT_URL);

  const card = page.getByRole("region", { name: "Get ready to go live" });
  await expect(card).toBeVisible();
  await expect(card.getByText("2 of 6 done")).toBeVisible();
  await expect(
    card.getByText("Your room shows a placeholder price. Set real prices before you go live."),
  ).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-go-live-d.png") });
  await assertHealthy();

  await card.getByRole("button", { name: "Add rates" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
});

test("lays the go-live list out for phones", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 2400 });
  await mockSetupChecklist(page, goLiveChecklistFacts(PMS_WEB_PROPERTY_ID));
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Get ready to go live" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-go-live-m.png") });
});
