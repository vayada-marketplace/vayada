import { expect, test } from "@playwright/test";

import {
  acceptedAgreementsStatus,
  mockHotelAccountAgreements,
} from "../support/hotelAccountAgreementsMocks";
import { watchPageHealth } from "../support/pageHealth";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

// VAY-2246: the PMS shows the account admin the same banner as Booking Admin until the hotel account accepts
// the hotel terms and the data processing agreement (Paper: VAY-2246 DPA acceptance, row 3).
const notAccepted = acceptedAgreementsStatus({ accepted: null });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
});

test("the account admin accepts from the banner on any page", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockHotelAccountAgreements(page, notAccepted);

  await page.goto("/settings");
  const banner = page.getByRole("region", { name: "Accept the data processing agreement" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("As account admin, you accept it for Alpenrose Hotels");
  await expect(banner.getByRole("link", { name: "Read the agreement" })).toHaveAttribute(
    "href",
    /\/terms\/dpa$/,
  );
  await page.screenshot({ path: testInfo.outputPath("pms-agreements-banner-1440.png") });

  await banner.getByRole("button", { name: "Accept", exact: true }).click();
  const confirmation = page
    .getByRole("status")
    .filter({ hasText: "Data processing agreement accepted" });
  // The PMS has no page that shows the acceptance later, so the confirmation points nowhere.
  await expect(confirmation).toHaveText("Data processing agreement accepted for Alpenrose Hotels.");
  await expect(banner).toBeHidden();
  expect(writes).toEqual([
    {
      path: "/api/hotel-account/agreements/accept",
      body: { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" },
    },
  ]);
  await assertHealthy();
});

test("staff don't see the banner", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockHotelAccountAgreements(
    page,
    acceptedAgreementsStatus({ accepted: null, canAccept: false }),
  );
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByText("Accept the data processing agreement")).toHaveCount(0);
  await assertHealthy();
});

test("on a phone the banner fits and its buttons stack", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHotelAccountAgreements(page, notAccepted);
  await page.goto("/settings");
  const banner = page.getByRole("region", { name: "Accept the data processing agreement" });
  await expect(banner).toBeVisible();
  const read = await banner.getByRole("link", { name: "Read the agreement" }).boundingBox();
  const accept = await banner.getByRole("button", { name: "Accept", exact: true }).boundingBox();
  expect(accept!.y).toBeGreaterThan(read!.y + read!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("pms-agreements-banner-390.png") });
});
