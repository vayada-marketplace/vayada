import { expect, test, type Route } from "@playwright/test";

import {
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  acceptedAgreementsStatus,
  mockHotelAccountAgreements,
} from "../support/hotelAccountAgreementsMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2246: an existing hotel account accepts the hotel terms and the data processing agreement through its
// account admin (Paper: VAY-2246 DPA acceptance, rows 3 and 4).
const current = { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" };
const notAccepted = acceptedAgreementsStatus({ accepted: null });

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page, {
    propertySettings: { ...defaultBookingAdminPropertySettings, property_name: "Hotel Alpenrose" },
  });
});

test("the account admin accepts the data processing agreement from the banner", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockHotelAccountAgreements(page, notAccepted);

  await page.goto("/dashboard");
  const banner = page.getByRole("region", { name: "Accept the data processing agreement" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("As account admin, you accept it for Alpenrose Hotels");
  await expect(banner).toContainText(
    "Version of 24 October 2026 · Only the account admin sees this.",
  );
  await expect(banner.getByRole("link", { name: "hotel terms" })).toHaveAttribute(
    "href",
    /\/terms$/,
  );
  await expect(banner.getByRole("link", { name: "Read the agreement" })).toHaveAttribute(
    "href",
    /\/terms\/dpa$/,
  );
  await page.screenshot({ path: testInfo.outputPath("agreements-banner-1440.png") });

  await banner.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(banner).toBeHidden();
  const confirmation = page
    .getByRole("status")
    .filter({ hasText: "Data processing agreement accepted" });
  await expect(confirmation).toHaveText(
    "Data processing agreement accepted for Alpenrose Hotels. You’ll find it in Settings → Privacy & data.",
  );
  await expect(page.getByRole("link", { name: "Settings → Privacy & data" })).toHaveAttribute(
    "href",
    "/settings/privacy",
  );
  expect(writes).toEqual([{ path: "/api/hotel-account/agreements/accept", body: current }]);
  await page.screenshot({ path: testInfo.outputPath("agreements-accepted-1440.png") });

  await confirmation.getByRole("button", { name: "Close" }).click();
  await expect(confirmation).toBeHidden();
  await assertHealthy();
});

test("the banner stacks its buttons on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHotelAccountAgreements(page, notAccepted);

  await page.goto("/dashboard");
  const banner = page.getByRole("region", { name: "Accept the data processing agreement" });
  await expect(banner).toBeVisible();
  const read = await banner.getByRole("link", { name: "Read the agreement" }).boundingBox();
  const accept = await banner.getByRole("button", { name: "Accept", exact: true }).boundingBox();
  expect(accept!.y).toBeGreaterThan(read!.y + read!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("agreements-banner-390.png") });
});

test("staff and accounts that already accepted see no banner", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockHotelAccountAgreements(
    page,
    acceptedAgreementsStatus({ accepted: null, canAccept: false }),
  );
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page.getByText("Accept the data processing agreement")).toHaveCount(0);

  await mockHotelAccountAgreements(page, acceptedAgreementsStatus());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page.getByText("Accept the data processing agreement")).toHaveCount(0);
  await assertHealthy();
});

test.describe("Settings › Privacy & data", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, (route) => {
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: corsHeaders(route) });
      return route.fulfill({
        headers: corsHeaders(route),
        json: route.request().url().includes("/history")
          ? { history: [] }
          : {
              terms_accepted: false,
              terms_accepted_at: null,
              terms_version: null,
              privacy_accepted: false,
              privacy_accepted_at: null,
              privacy_version: null,
              marketing_consent: false,
              marketing_consent_at: null,
            },
      });
    });
  });

  test("shows who accepted which versions", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockHotelAccountAgreements(page, acceptedAgreementsStatus());
    await page.goto("/settings/privacy");

    await expect(
      page.getByRole("heading", { name: "Agreements for Alpenrose Hotels" }),
    ).toBeVisible();
    const terms = page.getByRole("listitem").filter({ hasText: "Terms of Service (hotel terms)" });
    const dpa = page.getByRole("listitem").filter({ hasText: "Data processing agreement" });
    for (const row of [terms, dpa]) {
      await expect(row).toContainText("Version of 24 October 2026");
      await expect(row).toContainText("Accepted on 24 Oct 2026 by Anna Keller");
    }
    await expect(terms.getByRole("link", { name: "Read" })).toHaveAttribute("href", /\/terms$/);
    await expect(dpa.getByRole("link", { name: "Read" })).toHaveAttribute("href", /\/terms\/dpa$/);
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("privacy-agreements-accepted-1440.png") });
    await assertHealthy();
  });

  test("the account admin accepts on the page; the banner stays off it", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const writes = await mockHotelAccountAgreements(page, notAccepted);
    await page.goto("/settings/privacy");

    const card = page.getByRole("heading", { name: "Agreements for Alpenrose Hotels" });
    await expect(card).toBeVisible();
    await expect(page.getByText("Not accepted yet")).toHaveCount(2);
    await expect(
      page.getByText("As account admin, you accept both for Alpenrose Hotels."),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Accept the data processing agreement" }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("privacy-agreements-missing-1440.png") });

    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByText("Accepted on 24 Oct 2026 by Booking Owner")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(writes).toEqual([{ path: "/api/hotel-account/agreements/accept", body: current }]);
    await assertHealthy();
  });

  test("staff are told the account admin accepts", async ({ page }) => {
    await mockHotelAccountAgreements(
      page,
      acceptedAgreementsStatus({ accepted: null, canAccept: false }),
    );
    await page.goto("/settings/privacy");
    await expect(page.getByText("Your account admin can accept them.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  });
});
