import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

type Write = { store: string; moduleId: string; isActive: boolean };

// VAY-2200: six switchable modules from three stores; Guests joined in VAY-2423, on by default.
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
  const writes: Write[] = [];
  const store = async (name: string, supported: string[], initial: string[]) => {
    const active = new Set(initial);
    await page.route(
      new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/${name}(?:/[\\w-]+)?$`),
      (route) => {
        if (route.request().method() === "PATCH") {
          const body = route.request().postDataJSON() as { moduleId: string; isActive: boolean };
          writes.push({ store: name, ...body });
          if (body.isActive) active.add(body.moduleId);
          else active.delete(body.moduleId);
          return route.fulfill({
            json: {
              ...body,
              activatedAt: null,
              deactivatedAt: null,
              updatedAt: "2026-10-15T00:00:00Z",
            },
          });
        }
        return route.fulfill({
          json: {
            hotelId: PMS_WEB_PROPERTY_ID,
            canManage: true,
            supportedModules: supported,
            activeModules: Array.from(active),
            activations: [],
          },
        });
      },
    );
  };
  await store("navigation-modules", ["inbox", "reviews", "guests"], ["guests"]);
  await store("booking-modules", ["add-ons", "promos"], ["add-ons"]);
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

const preview = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Navigation", exact: true }) });

test("lists every module in one grid and previews both menus as they switch", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await setup(page);
  await page.goto("/settings/feature-hub");

  const cards = page.locator("article");
  for (const name of ["Guests", "Inbox", "Reviews", "Financials", "Add-ons", "Promos"])
    await expect(cards.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  await expect(cards).toHaveCount(6);
  await expect(page.getByText("/ 6 active", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Deactivate Guests" })).toBeChecked();
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Search modules...")).toHaveCount(0);
  await expect(
    page.getByText("Disabled modules stay hidden from the sidebar.", { exact: false }),
  ).toBeVisible();
  await expect(preview(page).getByText("11 items", { exact: true })).toBeVisible();
  await expect(preview(page).getByText("2 from modules", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Activate Financials" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("feature-hub-1440.png") });

  await page.getByRole("switch", { name: "Activate Inbox" }).click();
  await expect(page.getByRole("switch", { name: "Deactivate Inbox" })).toBeChecked();
  await expect(preview(page).getByText("3 from modules", { exact: true })).toBeVisible();
  const items = preview(page).getByRole("listitem");
  const reservationsBox = await items.filter({ hasText: /^Reservations$/ }).boundingBox();
  const guestsBox = await items.filter({ hasText: /^Guests$/ }).boundingBox();
  const inboxBox = await items.filter({ hasText: /^Inbox$/ }).boundingBox();
  // The sidebar order: Reservations, Guests, Inbox.
  expect(guestsBox!.y).toBeGreaterThan(reservationsBox!.y);
  expect(inboxBox!.y).toBeGreaterThan(guestsBox!.y);

  await page.getByRole("switch", { name: "Activate Promos" }).click();
  await expect(page.getByRole("switch", { name: "Deactivate Promos" })).toBeChecked();
  await expect(items.filter({ hasText: /^Promos$/ })).toBeVisible();
  await expect(preview(page).getByText("13 items", { exact: true })).toBeVisible();
  await expect(page.getByText("Promos activated.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("feature-hub-promos-on.png") });

  await page.getByRole("switch", { name: "Deactivate Add-ons" }).click();
  await expect(items.filter({ hasText: /^Add-ons$/ })).toHaveCount(0);
  await page.getByRole("switch", { name: "Deactivate Guests" }).click();
  await expect(items.filter({ hasText: /^Guests$/ })).toHaveCount(0);
  expect(writes).toEqual([
    { store: "navigation-modules", moduleId: "inbox", isActive: true },
    { store: "booking-modules", moduleId: "promos", isActive: true },
    { store: "booking-modules", moduleId: "add-ons", isActive: false },
    { store: "navigation-modules", moduleId: "guests", isActive: false },
  ]);
});

test("opens a module's details on a phone and switches it there", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const writes = await setup(page);
  await page.goto("/settings/feature-hub");

  await page.getByRole("button", { name: "Promos", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Promos" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Promo codes with usage limits")).toBeVisible();
  await expect(
    dialog.getByText("Last-minute discounts keep running", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("feature-hub-promos-details-390.png") });
  await dialog.getByRole("switch", { name: "Activate Promos" }).click();
  await expect(dialog.getByRole("switch", { name: "Deactivate Promos" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ store: "booking-modules", moduleId: "promos", isActive: true }]);
});
