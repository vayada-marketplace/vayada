import { expect, test, type Page } from "@playwright/test";

/** The old affiliate product is retired (VAY-1499). Feature Hub shows it as currently unavailable
 * (VAY-2200/2143): no switch, no Affiliates page in the menus, and no writes, whatever the legacy
 * activation says. */
export function featureHubRetirementChecks(
  propertyId: string,
  setup: (page: Page) => Promise<void>,
) {
  for (const active of [false, true]) {
    test(`Feature Hub shows retired affiliates as unavailable without changing records (active: ${active})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: active ? 390 : 1280, height: 900 });
      await setup(page);
      // Only the retired affiliates entry is under test; the other stores add nothing here.
      for (const store of ["navigation-modules", "booking-modules"])
        await page.route(new RegExp(`/api/pms/properties/${propertyId}/${store}$`), (route) =>
          route.fulfill({
            json: {
              hotelId: propertyId,
              canManage: true,
              supportedModules: [],
              activeModules: [],
              activations: [],
            },
          }),
        );
      let reads = 0;
      let writes = 0;
      await page.route(
        new RegExp(`/api/pms/properties/${propertyId}/module-activations(?:/affiliates)?$`),
        async (route) => {
          const request = route.request();
          if (request.method() === "GET") {
            reads++;
            return route.fulfill({
              json: {
                hotelId: propertyId,
                canManage: true,
                supportedModules: ["affiliates"],
                activeModules: active ? ["affiliates"] : [],
                activations: [{ moduleId: "affiliates", isActive: active }],
              },
            });
          }
          if (request.method() !== "OPTIONS") writes++;
          return route.fulfill({ status: 204 });
        },
      );
      await page.goto("/settings/feature-hub");
      await expect.poll(() => reads).toBeGreaterThan(0);
      const card = page.locator("article").filter({ hasText: "Affiliate Tracking" });
      await expect(card).toBeVisible();
      await expect(card.getByText("This feature is currently unavailable.")).toBeVisible();
      await expect(card.getByRole("switch")).toHaveCount(0);
      await expect(page.getByRole("switch")).toHaveCount(0);
      await expect(page.locator('a[href="/affiliates"]')).toHaveCount(0);
      await expect(page.getByRole("listitem").filter({ hasText: /^Affiliates$/ })).toHaveCount(0);
      const beforeReload = reads;
      await page.reload();
      await expect.poll(() => reads).toBeGreaterThan(beforeReload);
      await expect(card).toBeVisible();
      expect(writes).toBe(0);
    });
  }
}
