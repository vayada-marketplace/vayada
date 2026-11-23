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
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await expect(navigation.getByRole("link")).toHaveCount(NAV_LABELS.length);
    expect(
      await navigation.locator("a").evaluateAll((links) => links.map((link) => link.title)),
    ).toEqual(NAV_LABELS);
  });

  test("collapses and expands from the toggle next to Booking Engine and remembers it (VAY-2593)", async ({
    page,
  }) => {
    await page.goto("/");
    const navigation = page.getByRole("navigation", { name: "Main" });
    const sidebar = page.locator("aside").filter({ has: navigation });
    const title = sidebar.getByText("Booking Engine", { exact: true });
    const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
    const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
    const width = async () => (await sidebar.boundingBox())!.width;

    // Expanded: the toggle sits right of "Booking Engine", above the menu, and the title keeps
    // one line beside it.
    await expect(title).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(collapse).toHaveAttribute("title", "Collapse sidebar");
    const titleBox = (await title.boundingBox())!;
    const toggleBox = (await collapse.boundingBox())!;
    const titleRight = await title.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().right;
    });
    // One line of 12px text (two would be about 30px), and the toggle right of its last letter.
    expect(titleBox.height).toBeLessThan(20);
    expect(toggleBox.x).toBeGreaterThan(titleRight);
    expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual((await navigation.boundingBox())!.y);
    // The old "Collapse" link at the bottom is gone.
    await expect(page.getByRole("button", { name: "Collapse", exact: true })).toHaveCount(0);
    await expect.poll(width).toBe(240);

    // Collapsed: a 64px icon rail; only the toggle stays at the top; names become tooltips.
    await collapse.click();
    await expect(expand).toBeVisible();
    await expect(expand).toHaveAttribute("title", "Expand sidebar");
    await expect.poll(width).toBe(64);
    await expect(title).toBeHidden();
    await expect(sidebar.getByRole("button")).toHaveCount(1);
    await expect(navigation.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "title",
      "Settings",
    );
    await expect(navigation.getByText("Settings", { exact: true })).toBeHidden();
    // The page content takes the freed width.
    expect((await page.locator("main").boundingBox())!.x).toBeLessThanOrEqual(64);

    // Remembered across a reload and a fresh load of another page.
    await page.reload();
    await expect(expand).toBeVisible();
    await expect.poll(width).toBe(64);
    await page.goto("/settings");
    await expect(expand).toBeVisible();
    await expect.poll(width).toBe(64);

    // Expanded again: the full sidebar, also after a reload.
    await expand.click();
    await expect(collapse).toBeVisible();
    await expect.poll(width).toBe(240);
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    await page.reload();
    await expect(collapse).toBeVisible();
    await expect(title).toBeVisible();
  });

  test("opens the phone menu in full even when the sidebar was collapsed (VAY-2593)", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("vayada.bookingAdmin.sidebarCollapsed", "true"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle menu", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Main" });
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    for (const label of NAV_LABELS) {
      await expect(navigation.getByText(label, { exact: true })).toBeVisible();
    }
    const sidebar = page.locator("aside").filter({ has: navigation });
    await expect(sidebar.getByText("Booking Engine", { exact: true })).toBeVisible();
    // The drawer floats over the page, so it has nothing to collapse.
    await expect(sidebar.getByRole("button", { name: /sidebar$/ })).toHaveCount(0);
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
