import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { mockBookingModules } from "../support/featureHubModuleMocks";

// Booking Flow's pages and Feature Hub live under Settings (VAY-2133, VAY-2144).
const NAV_LABELS = ["Dashboard", "Design Studio", "Add-ons", "Promos", "Settings"];

test.describe("booking-admin navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
  });

  test("shows the product navigation in order when expanded and collapsed", async ({ page }) => {
    await page.goto("/");

    const navigation = page.getByRole("navigation");
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);

    // exact: in dev, Next's "Collapse issues badge" button also matches "Collapse".
    await page.getByRole("button", { name: "Collapse", exact: true }).click();
    await expect(navigation.getByRole("link")).toHaveCount(NAV_LABELS.length);
    expect(
      await navigation.locator("a").evaluateAll((links) => links.map((link) => link.title)),
    ).toEqual(NAV_LABELS);
  });

  test("hides Add-ons or Promos only once Feature Hub says they are off (VAY-2200)", async ({
    page,
  }) => {
    await mockBookingModules(page, BOOKING_ADMIN_PROPERTY_ID, ["add-ons"]);
    await page.goto("/");

    const navigation = page.getByRole("navigation", { name: "Main" });
    await expect(navigation.getByRole("link", { name: "Add-ons" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Promos" })).toHaveCount(0);
  });

  test("hides a switched-off module for staff who can't read Financials (VAY-2200)", async ({
    page,
  }) => {
    await mockBookingModules(page, BOOKING_ADMIN_PROPERTY_ID, ["add-ons"]);
    await page.route("**/api/pms/properties/*/module-activations", (route) =>
      route.fulfill({ status: 403, json: { code: "forbidden" } }),
    );
    await page.goto("/");

    const navigation = page.getByRole("navigation", { name: "Main" });
    await expect(navigation.getByRole("link", { name: "Add-ons" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Promos" })).toHaveCount(0);

    await page.goto("/settings/feature-hub");
    await expect(
      page.getByRole("heading", { level: 2, name: "Promos", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Could not load modules. Please retry.")).toHaveCount(0);
  });

  test("marks Settings current on the pages that moved under it", async ({ page }) => {
    // Settings pages also have a breadcrumb navigation with a "Settings" link; use the menu.
    const menu = page.getByRole("navigation", { name: "Main" });
    for (const path of [
      "/settings/feature-hub",
      "/settings/room-filters",
      "/settings/guest-form",
    ]) {
      await page.goto(path);
      await expect(menu.getByRole("link", { name: "Settings" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(menu.locator("[aria-current=page]")).toHaveCount(1);
    }
  });

  test("shows the same order in the mobile drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const navigation = page.getByRole("navigation");
    await expect(navigation).not.toBeInViewport();
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await expect(navigation).toBeInViewport();
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);
  });
});
