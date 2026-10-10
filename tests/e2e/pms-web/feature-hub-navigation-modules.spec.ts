import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2078: Inbox and Reviews are Feature Hub modules, off by default, stored apart from Financials.
async function setup(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-operator-membership",
        roleKey: "hotel_owner",
        permissions: ["pms.finance.read", "pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
  const active = new Set<string>();
  const writes: Array<{ moduleId: string; isActive: boolean }> = [];
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/navigation-modules(?:/\\w+)?$`),
    (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { moduleId: string; isActive: boolean };
        writes.push(body);
        if (body.isActive) active.add(body.moduleId);
        else active.delete(body.moduleId);
        return route.fulfill({
          json: {
            ...body,
            activatedAt: null,
            deactivatedAt: null,
            updatedAt: "2026-10-09T00:00:00Z",
          },
        });
      }
      return route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: true,
          supportedModules: ["inbox", "reviews"],
          activeModules: Array.from(active),
          activations: [],
        },
      });
    },
  );
  // An operator: the Owner-only Financials switch stays read-only.
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations$`),
    (route) =>
      route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: false,
          supportedModules: ["financials"],
          activeModules: [],
          activations: [],
        },
      }),
  );
  return writes;
}

test("lists Inbox and Reviews off by default and previews the sidebar as they switch", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const writes = await setup(page);
  await page.goto("/settings/feature-hub");

  const cards = page.locator("article");
  for (const name of ["Inbox", "Reviews", "Financials"])
    await expect(cards.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  await expect(page.getByText("0 Active", { exact: true })).toBeVisible();
  await expect(page.getByText("6 items", { exact: true })).toBeVisible();
  await expect(page.getByText("0 module items", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Activate Financials" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("feature-hub-modules-off.png") });

  await page.getByRole("switch", { name: "Activate Inbox" }).click();
  await expect(page.getByRole("switch", { name: "Deactivate Inbox" })).toBeChecked();
  await expect(page.getByText("1 Active", { exact: true })).toBeVisible();
  await expect(page.getByText("7 items", { exact: true })).toBeVisible();
  await expect(page.getByText("1 module items", { exact: true })).toBeVisible();
  const preview = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "PMS navigation" }) })
    .getByRole("listitem");
  await expect(preview.filter({ hasText: /^Reservations$/ })).toBeVisible();
  const reservationsBox = await preview.filter({ hasText: /^Reservations$/ }).boundingBox();
  const inboxBox = await preview.filter({ hasText: /^Inbox$/ }).boundingBox();
  expect(inboxBox!.y).toBeGreaterThan(reservationsBox!.y);

  await page.getByRole("switch", { name: "Activate Reviews" }).click();
  await expect(page.getByText("2 Active", { exact: true })).toBeVisible();
  await expect(page.getByText("2 module items", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("feature-hub-modules-on.png") });

  await page.getByRole("switch", { name: "Deactivate Inbox" }).click();
  await expect(page.getByText("1 Active", { exact: true })).toBeVisible();
  await expect(preview.filter({ hasText: /^Inbox$/ })).toHaveCount(0);
  expect(writes).toEqual([
    { moduleId: "inbox", isActive: true },
    { moduleId: "reviews", isActive: true },
    { moduleId: "inbox", isActive: false },
  ]);
});

test("files Inbox under Operations and Reviews under Distribution", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto("/settings/feature-hub");

  const cards = page.locator("article");
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(cards.getByRole("heading", { level: 2, name: "Inbox", exact: true })).toBeVisible();
  await expect(cards.getByRole("heading", { level: 2, name: "Reviews", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Distribution", exact: true }).click();
  await expect(
    cards.getByRole("heading", { level: 2, name: "Reviews", exact: true }),
  ).toBeVisible();
  await expect(cards.getByRole("heading", { level: 2, name: "Inbox", exact: true })).toHaveCount(0);
});
