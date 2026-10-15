import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { mockBookingModules } from "../support/featureHubModuleMocks";

const NAV_LABELS = [
  "Dashboard",
  "Design Studio",
  "Booking Flow",
  "Add-ons",
  "Promos",
  "Settings",
  "Feature Hub",
];

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

    const navigation = page.getByRole("navigation");
    await expect(navigation.getByRole("link", { name: "Add-ons" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Promos" })).toHaveCount(0);
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
