import { expect, test, type Page } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2454: the header's property switcher lists properties A–Z by name, ignoring case and accents,
// whatever order the API sends. The current property stays highlighted in its place and
// "Add Property" stays last.
type OtherProperty = { propertyId: string; displayName: string; locationSummary: string };

const otherProperty = (n: number, displayName: string): OtherProperty => ({
  propertyId: `f6853000-0000-4000-8000-00000000245${n}`,
  displayName,
  locationSummary: "Kabupaten Gianyar, ID",
});

test("the property switcher lists properties A–Z and keeps Add Property last", async ({ page }) => {
  const others = [
    otherProperty(1, "The Mansion Resort Hotel & Spa"),
    otherProperty(2, "Dewari Villa"),
    otherProperty(3, "Uma Una"),
    otherProperty(4, "Éden Villa"),
    otherProperty(5, "adhidrawa Ubud"),
  ];
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  // Routed after the shared mocks, so this multi-property status wins.
  await page.route("**/api/hotel-setup/status**", (route) => {
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "pms",
      organizationId: "org_pms_owner",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["hotel_operations"],
      propertyId: PMS_WEB_PROPERTY_ID,
      publicId: "prop_alpenrose",
      propertyDisplayName: "Alpenrose Munich",
      locationSummary: "Munich, DE",
      entryDecision: {
        propertyId: PMS_WEB_PROPERTY_ID,
        decision: "enter",
        destinationRouteKey: "pms.workspace",
        reasonCode: null,
      },
    });
    return route.fulfill({
      json: {
        ...status,
        propertySelection: {
          state: "multiple_properties",
          selectedPropertyId:
            new URL(route.request().url()).searchParams.get("propertyId") ?? PMS_WEB_PROPERTY_ID,
          availableProperties: [
            ...others.map((property) => ({ ...property, publicId: property.propertyId })),
            ...status.propertySelection.availableProperties,
          ],
        },
      },
    });
  });

  await page.goto("/dashboard");
  expect(await switcherItems(page)).toEqual([
    "adhidrawa Ubud",
    "Alpenrose Munich",
    "Dewari Villa",
    "Éden Villa",
    "The Mansion Resort Hotel & Spa",
    "Uma Una",
    "Add Property",
  ]);
  await expect(switcherPanel(page).getByRole("button", { name: /Alpenrose Munich/ })).toHaveClass(
    /bg-primary-500/,
  );

  // A property added later shows up in its alphabetical spot after the reload.
  others.push(otherProperty(6, "Bali Breeze"));
  await page.reload();
  expect(await switcherItems(page)).toEqual([
    "adhidrawa Ubud",
    "Alpenrose Munich",
    "Bali Breeze",
    "Dewari Villa",
    "Éden Villa",
    "The Mansion Resort Hotel & Spa",
    "Uma Una",
    "Add Property",
  ]);
});

function switcherPanel(page: Page) {
  return page.locator("header").getByText("Switch Property").locator("..");
}

/** Opens the switcher and returns each item's first line (the property name), in order. */
async function switcherItems(page: Page): Promise<string[]> {
  const switcher = page.locator("header button[title]").first();
  await expect(switcher).toContainText("Alpenrose Munich");
  await switcher.click();
  const items = switcherPanel(page).getByRole("button");
  await expect(items.last()).toHaveText("Add Property");
  return (await items.allInnerTexts()).map((text) => text.split("\n")[0]!.trim());
}
