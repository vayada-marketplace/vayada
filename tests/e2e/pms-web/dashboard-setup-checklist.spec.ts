import { expect, test } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { liveChecklistFacts, mockSetupChecklist } from "../support/setupChecklistMocks";

// VAY-2247 wave 2: the setup checklist on the PMS dashboard, shown only where the server offers it.
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

test("shows the checklist instead of the banner once the server answers (c01-1)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockSetupChecklist(page, liveChecklistFacts(PMS_WEB_PROPERTY_ID));
  await page.goto(EXIT_URL);

  const card = page.getByRole("region", { name: /Finish setting up/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("4 of 9 done").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
  // The mocked hotel sells one room tonight.
  await expect(
    card.getByText(/Open all year · 1 room bookable/).filter({ visible: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-checklist-d.png") });

  await card.getByRole("button", { name: "Looks good" }).first().click();
  await expect(page.getByText("Calendar confirmed — your defaults stay.")).toBeVisible();
  await expect(card.getByText("5 of 9 done").filter({ visible: true })).toBeVisible();

  await card.getByRole("button", { name: "Hide for now" }).click();
  await expect(card).toHaveCount(0);
  const pill = page.getByRole("button", { name: "Setup 5 of 9" });
  await expect(pill).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-checklist-hidden-d.png") });
  await pill.click();
  await expect(page.getByRole("region", { name: /Finish setting up/ })).toBeVisible();

  expect(
    writes.map(({ method, path, body }) => [method, path.split("/checklist")[1], body]),
  ).toEqual([
    ["POST", "/acknowledgements", { item: "calendar" }],
    ["PUT", "/viewer", { hidden: true }],
    ["PUT", "/viewer", { hidden: false }],
  ]);
  await assertHealthy();
});

test("lays the checklist out for phones (c01-1m)", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 2400 });
  await mockSetupChecklist(page, liveChecklistFacts(PMS_WEB_PROPERTY_ID));
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: /Finish setting up/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-dashboard-checklist-m.png") });
});
