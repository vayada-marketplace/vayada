import type { Page } from "@playwright/test";

/** VAY-2200: Add-ons and Promos switches, both on unless a spec overrides the route. */
export async function mockBookingModules(
  page: Page,
  propertyId: string,
  activeModules: string[] = ["add-ons", "promos"],
): Promise<void> {
  await page.route(
    new RegExp(`/api/pms/properties/${propertyId}/booking-modules(?:/(?:add-ons|promos))?$`),
    (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            json: {
              ...route.request().postDataJSON(),
              activatedAt: null,
              deactivatedAt: null,
              updatedAt: "2026-10-15T00:00:00.000Z",
            },
          })
        : route.fulfill({
            json: {
              hotelId: propertyId,
              canManage: true,
              supportedModules: ["add-ons", "promos"],
              activeModules,
              activations: [],
              manageableModules: ["add-ons", "promos"],
            },
          }),
  );
}
