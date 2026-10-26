import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_OWNER_PERMISSIONS,
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { checkinSettingsResponse, defaultCheckinSettings } from "../support/checkinSettingsMocks";

// VAY-2374: Settings → Check-in, as approved in Paper (VAY-2372-2374 Check-in, 2026-10-26).
const property = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}`;
const ADDONS = [
  {
    addonItemId: "a1000000-0000-4000-8000-000000000001",
    name: "Scooter rental",
    pricingModel: "per_night",
    price: "10.00",
  },
  {
    addonItemId: "a1000000-0000-4000-8000-000000000002",
    name: "Breakfast",
    pricingModel: "per_guest_night",
    price: "8.00",
  },
  {
    addonItemId: "a1000000-0000-4000-8000-000000000003",
    name: "Late check-out",
    pricingModel: "per_stay",
    price: "20.00",
  },
].map((addon) => ({ ...addon, description: "", currency: "EUR", category: "" }));
const cityTax = {
  stepId: "c1000000-0000-4000-8000-000000000001",
  label: "City tax collected",
  required: true,
  type: "amount",
};

async function mockCheckinSettings(page: Page, { canManage = true } = {}) {
  const writes: { settings: unknown[]; checklist: unknown[] } = { settings: [], checklist: [] };
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`${property}/check-in-settings`, async (route) => {
    if (route.request().method() === "PUT") {
      const settings = route.request().postDataJSON();
      writes.settings.push(settings);
      return route.fulfill({
        json: checkinSettingsResponse(settings, { updatedAt: "2026-10-26T12:00:00Z" }),
      });
    }
    return route.fulfill({ json: checkinSettingsResponse({}, { canManage }) });
  });
  await page.route(`${property}/check-in-checklist`, async (route) => {
    const steps =
      route.request().method() === "PUT"
        ? (route.request().postDataJSON() as { steps: unknown[] }).steps
        : [cityTax];
    if (route.request().method() === "PUT") writes.checklist.push(steps);
    return route.fulfill({
      json: { template: { steps, updatedAt: null, updatedByUserId: null } },
    });
  });
  await page.route(`${property}/manual-bookings/addons`, (route) =>
    route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: ADDONS } }),
  );
  return writes;
}

test("edits the check-in and saves it as one object, extra checks included", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinSettings(page);
  await page.goto("/settings/check-in");

  const main = page.locator("main");
  await expect(main.getByRole("heading", { level: 1, name: "Check-in" })).toBeVisible();
  const overview = main.getByRole("navigation", { name: "Check-in steps" });
  await expect(overview).toContainText("Request + confirmation");
  await expect(overview).toContainText("6 required fields");
  await expect(overview).toContainText("3 add-ons offered");
  await expect(overview).toContainText("Physical keys · 1 checks");
  await expect(main.getByRole("textbox").first()).toHaveValue("City tax collected");

  // Hiding the special request also drops the confirmation.
  await main.getByRole("switch", { name: "Show special request" }).click();
  const confirm = main.getByRole("switch", { name: "Staff confirm they read it" });
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAttribute("aria-checked", "false");

  // Requiring a hidden field shows it too.
  await main.getByRole("switch", { name: "Require Gender" }).click();
  await expect(main.getByRole("switch", { name: "Show Gender" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(main.getByText("7 required", { exact: true })).toBeVisible();

  await main.getByRole("button", { name: "Remove Breakfast" }).click();
  await expect(overview).toContainText("2 add-ons offered");
  await main.getByRole("button", { name: "Cash", exact: true }).click();
  await main.getByText("No key step", { exact: true }).click();

  await main.getByRole("button", { name: "Add check" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(main.getByText("Name the check.")).toBeVisible();
  expect(writes.settings).toHaveLength(0);

  await main.getByRole("textbox").nth(1).fill("Wi-Fi and breakfast times explained");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Check-in settings saved." }),
  ).toBeVisible();

  expect(writes.settings).toEqual([
    {
      ...defaultCheckinSettings,
      showSpecialRequest: false,
      confirmSpecialRequest: false,
      guestFields: defaultCheckinSettings.guestFields.map((entry) =>
        entry.field === "gender" ? { field: "gender", show: true, required: true } : entry,
      ),
      addonIds: [ADDONS[0]!.addonItemId, ADDONS[2]!.addonItemId],
      settlementOptions: ["card", "bank_transfer", "at_checkout", "already_paid"],
      keyHandover: "none",
    },
  ]);
  expect(writes.checklist).toEqual([
    [
      cityTax,
      expect.objectContaining({
        label: "Wi-Fi and breakfast times explained",
        type: "checkbox",
        required: false,
      }),
    ],
  ]);
  await assertHealthy();
});

test("leaves the extra checks alone when only a setting changed", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinSettings(page);
  await page.goto("/settings/check-in");
  const main = page.locator("main");
  await expect(main.getByRole("textbox").first()).toHaveValue("City tax collected");
  await main.getByRole("switch", { name: "Show special request" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Check-in settings saved." }),
  ).toBeVisible();
  expect(writes.settings).toHaveLength(1);
  expect(writes.checklist).toHaveLength(0);
  await assertHealthy();
});

test("keeps the extra checks read-only without operations access", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinSettings(page);
  // Settings access but not operations: the checks are the check-in checklist, which needs it.
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-manager-membership",
        roleKey: "hotel_manager",
        permissions: PMS_WEB_OWNER_PERMISSIONS.filter(
          (permission) => permission !== "pms.operations.manage",
        ),
      },
    }),
  );
  await page.goto("/settings/check-in");
  const main = page.locator("main");
  await expect(
    main.getByText("Only staff who can manage operations can change the extra checks."),
  ).toBeVisible();
  await expect(main.getByRole("button", { name: "Add check" })).toBeDisabled();
  await main.getByRole("switch", { name: "Show special request" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Check-in settings saved." }),
  ).toBeVisible();
  expect(writes.settings).toHaveLength(1);
  expect(writes.checklist).toHaveLength(0);
  await assertHealthy();
});

test("shows front desk staff the check-in settings without letting them change them", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinSettings(page, { canManage: false });
  await page.goto("/settings/check-in");

  const main = page.locator("main");
  await expect(
    main.getByText(/only owners and managers with settings access can change them/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(main.getByRole("switch", { name: "Show special request" })).toBeDisabled();
  await expect(main.getByRole("button", { name: "Add check" })).toBeDisabled();
  await assertHealthy();
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`Settings → Check-in fits ${width}px without sideways scrolling`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await mockCheckinSettings(page);
    await page.goto("/settings/check-in");
    await expect(page.locator("main").getByRole("textbox").first()).toHaveValue(
      "City tax collected",
    );
    // Both guest-field columns fit, as on the approved 390 board; the page never scrolls sideways
    // (sr-only labels too).
    const tableOverflow = await page
      .locator("main table")
      .evaluate((table) => table.parentElement!.scrollWidth - table.parentElement!.clientWidth);
    expect(tableOverflow).toBeLessThanOrEqual(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await testInfo.attach(`checkin-settings-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}
