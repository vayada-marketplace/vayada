import { expect, test, type Page, type Request } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2493: account menu › Manage Properties. The account admin deletes a property in two steps; the
// last property can't be deleted; other members don't get the page.
const DEWARI_ID = "f6853000-0000-4000-8000-000000002493";
const PROPERTIES = [
  {
    propertyId: PMS_WEB_PROPERTY_ID,
    publicId: "prop_alpenrose",
    displayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
  },
  {
    propertyId: DEWARI_ID,
    publicId: "prop_dewari",
    displayName: "Dewari Villa",
    locationSummary: "Ubud, ID",
  },
];

type Blocker = { code: string; count: number };

async function mockAccount(page: Page, options: { blockers?: Blocker[] } = {}) {
  const deleted = new Set<string>();
  const deletes: Request[] = [];
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  // Routed after the shared mocks, so this account with two properties wins.
  await page.route("**/api/hotel-setup/status**", (route) => {
    const remaining = PROPERTIES.filter((property) => !deleted.has(property.propertyId));
    const requested = new URL(route.request().url()).searchParams.get("propertyId");
    const selected =
      remaining.find((property) => property.propertyId === requested) ?? remaining[0]!;
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "pms",
      organizationId: "org_pms_owner",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["hotel_operations"],
      propertyId: selected.propertyId,
      publicId: selected.publicId,
      propertyDisplayName: selected.displayName,
      locationSummary: selected.locationSummary,
      entryDecision: {
        propertyId: selected.propertyId,
        decision: "enter",
        destinationRouteKey: "pms.workspace",
        reasonCode: null,
      },
    });
    return route.fulfill({
      json: {
        ...status,
        propertySelection: {
          state: remaining.length > 1 ? "multiple_properties" : "single_property",
          selectedPropertyId: selected.propertyId,
          availableProperties: remaining,
        },
      },
    });
  });
  await page.route("**/api/hotel-setup/properties/*/deletion-check", (route) => {
    const propertyId = route.request().url().split("/properties/")[1]!.split("/")[0]!;
    const property = PROPERTIES.find((candidate) => candidate.propertyId === propertyId)!;
    const blockers = options.blockers ?? [];
    return route.fulfill({
      json: {
        contractVersion: "hotel-property-deletion.v1",
        propertyId,
        displayName: property.displayName,
        lifecycleRevision: 4,
        accountProperties: PROPERTIES.length - deleted.size,
        blockers,
        canDelete: blockers.length === 0,
      },
    });
  });
  await page.route("**/api/hotel-setup/properties/*/delete", (route) => {
    const propertyId = route.request().url().split("/properties/")[1]!.split("/")[0]!;
    deletes.push(route.request());
    deleted.add(propertyId);
    return route.fulfill({
      json: { contractVersion: "hotel-property-deletion.v1", propertyId, deleted: true },
    });
  });
  return { deletes };
}

async function openAccountMenu(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: "PO", exact: true }).click();
}

test("the account admin deletes the open property in two steps and the PMS switches to the other one", async ({
  page,
}) => {
  const { deletes } = await mockAccount(page);
  await page.goto("/dashboard");

  await openAccountMenu(page);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const manage = page.getByRole("button", { name: "Manage Properties", exact: true });
  const language = page.getByRole("button", { name: /^Language/ });
  await expect(manage).toBeVisible();
  // Between Settings and Language.
  const [settingsBox, manageBox, languageBox] = await Promise.all(
    [settings, manage, language].map((item) => item.boundingBox()),
  );
  expect(settingsBox!.y).toBeLessThan(manageBox!.y);
  expect(manageBox!.y).toBeLessThan(languageBox!.y);
  await manage.click();

  await expect(page).toHaveURL(/\/manage-properties$/);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Manage Properties" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Delete Alpenrose Munich" })).toBeEnabled();
  await expect(main.getByRole("button", { name: "Delete Dewari Villa" })).toBeEnabled();

  await main.getByRole("button", { name: "Delete Alpenrose Munich" }).click();
  const review = page.getByRole("dialog", { name: "Delete Alpenrose Munich?" });
  await expect(review).toContainText("Its bookings, payments and guest records are kept");
  await review.getByRole("button", { name: "Delete property" }).click();

  const confirm = page.getByRole("dialog", { name: "Confirm deletion" });
  const confirmButton = confirm.getByRole("button", { name: "Confirm deletion" });
  await expect(confirmButton).toBeDisabled();
  await confirm.getByLabel("Property name").fill("alpenrose munich");
  await expect(confirmButton).toBeDisabled();
  await confirm.getByLabel("Property name").fill("Alpenrose Munich");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // The page reloads: the property is gone from the switcher and the list, the PMS now shows Dewari.
  await expect(page.getByRole("status").filter({ hasText: "has been deleted" })).toHaveText(
    "Alpenrose Munich has been deleted.",
  );
  await expect(page.locator("header button[title]").first()).toContainText("Dewari Villa");
  await expect(main.getByRole("button", { name: /^Delete / })).toHaveCount(1);
  await expect(main.getByRole("button", { name: "Delete Dewari Villa" })).toBeDisabled();
  await expect(main).toContainText(
    "An account needs at least one property, so its last property can't be deleted.",
  );
  expect(await page.evaluate(() => localStorage.getItem("selectedHotelId"))).toBe(DEWARI_ID);

  expect(deletes).toHaveLength(1);
  expect(deletes[0]!.url()).toContain(`/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/delete`);
  expect(deletes[0]!.postDataJSON()).toEqual({
    expectedLifecycleRevision: 4,
    confirmationName: "Alpenrose Munich",
  });
  expect(deletes[0]!.headers()["idempotency-key"]).toMatch(/^property-delete-/);
});

test("a property with upcoming bookings and a connected channel can't be deleted", async ({
  page,
}) => {
  const { deletes } = await mockAccount(page, {
    blockers: [
      { code: "upcoming_bookings", count: 3 },
      { code: "connected_channels", count: 1 },
    ],
  });
  await page.goto("/manage-properties");

  await page.getByRole("main").getByRole("button", { name: "Delete Dewari Villa" }).click();
  const review = page.getByRole("dialog", { name: "Delete Dewari Villa?" });
  await expect(review).toContainText("You can't delete this property yet:");
  await expect(review).toContainText(
    "It has 3 upcoming or current bookings. Cancel or move them first.",
  );
  await expect(review).toContainText("It's connected to a channel manager");
  await expect(review.getByRole("button", { name: "Delete property" })).toBeDisabled();
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toBeHidden();
  expect(deletes).toHaveLength(0);
});

test("members who are not the account admin don't get Manage Properties", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-manager-membership",
        roleKey: "hotel_manager",
        permissions: ["pms.dashboard.read", "pms.settings.read"],
      },
    }),
  );
  await page.goto("/dashboard");
  await openAccountMenu(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage Properties", exact: true })).toHaveCount(0);

  await page.goto("/manage-properties");
  await expect(page.getByRole("main")).toContainText(
    "Only the account admin can manage properties.",
  );
  await expect(page.getByRole("main").getByRole("button", { name: /^Delete / })).toHaveCount(0);
});
