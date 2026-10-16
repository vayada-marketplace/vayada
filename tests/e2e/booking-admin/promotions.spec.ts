import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test("manages all automatic promotions in Promos and preserves last-minute tiers", async ({
  page,
}, testInfo) => {
  test.skip(process.env.E2E_BOOKING_ADMIN_PROD !== "1", "Requires production booking-admin build.");
  const healthy = watchPageHealth(page, testInfo);
  const noLegacy = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");
  await mockBookingAdminBookingFlow(page);
  let settings: Record<string, any> = {
    enabled: true,
    stackWithPromo: true,
    tiers: [
      { daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 12.5 },
      { daysBeforeMin: 3, daysBeforeMax: 5, discountPercent: 0.5 },
    ],
    updatedAt: "2026-09-05T10:00:00Z",
  };
  const originalTiers = structuredClone(settings.tiers);
  await page.route(`**${BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH}*`, async (route) => {
    if (route.request().method() === "PUT")
      settings = { ...route.request().postDataJSON(), updatedAt: settings.updatedAt };
    await route.fulfill({ json: settings });
  });
  await page.goto("/promo-codes");
  await expect(page.getByRole("heading", { name: "Promos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Promotions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Last minute escape" }).click();
  const editor = page.getByRole("dialog", { name: "Edit last minute promotion" });
  await expect(
    editor.getByRole("spinbutton", { name: "Discount %", exact: true }).first(),
  ).toHaveValue("12.5");
  // VAY-2234: the shared window, with Active in the footer and the guest line.
  await expect(editor.getByRole("switch", { name: "Active" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(editor).toContainText("Guests will see: Last minute escape — Tiered percentage off");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(settings.promotions[0].tiers).toEqual(originalTiers);
  await page.getByRole("button", { name: "New promotion", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Last minute/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /^Last minute/ })).toContainText("Added");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  for (const [type, label, name] of [
    ["EARLY_BIRD", "Early bird", "Early bird"],
    ["EXTENDED_STAY", "Extended stay", "Extended stay"],
    ["MIDWEEK", "Midweek", "Midweek getaway"],
  ]) {
    await page.getByRole("button", { name: "New promotion", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
    const dialog = page.getByRole("dialog", { name: `New ${label!.toLowerCase()} promotion` });
    await expect(dialog).toBeVisible();
    if (type === "EXTENDED_STAY") {
      // Chips and cards hide their input; click the visible label like a guest would.
      const freeNights = dialog.getByRole("radio", { name: /^Free nights/ });
      await freeNights.locator("..").click();
      await expect(freeNights).toBeChecked();
      await dialog.getByLabel("Free nights", { exact: true }).fill("");
      await dialog.getByRole("button", { name: "Create promotion", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Free nights must be at least 1");
      await dialog.getByLabel("Free nights", { exact: true }).fill("2");
    }
    if (type === "MIDWEEK") {
      await dialog.getByRole("spinbutton", { name: "Discount", exact: true }).fill("120");
      await dialog.getByRole("button", { name: "Create promotion", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("Enter a discount from 0.01 to 100%.");
      await expect(
        dialog.getByRole("spinbutton", { name: "Discount", exact: true }),
      ).toHaveAttribute("aria-invalid", "true");
      await dialog.getByRole("spinbutton", { name: "Discount", exact: true }).fill("10");
    }
    await dialog.getByRole("button", { name: "Create promotion", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: name!, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "New promotion", exact: true })).toHaveCount(0);
  expect(settings.promotions.find((p: any) => p.type === "EXTENDED_STAY")).toMatchObject({
    freeNights: 2,
    discountPercent: 0,
  });
  expect(settings.promotions.find((p: any) => p.type === "MIDWEEK")).toMatchObject({
    discountPercent: 10,
    weekdays: [0, 1, 2, 3, 4],
  });
  await page.getByRole("button", { name: "Edit Extended stay" }).click();
  const stayEditor = page.getByRole("dialog", { name: "Edit extended stay promotion" });
  await expect(stayEditor.getByRole("radio", { name: /^Free nights/ })).toBeChecked();
  await expect(stayEditor.getByLabel("Free nights", { exact: true })).toHaveValue("2");
  await stayEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(stayEditor).toHaveCount(0);
  const toggle = page.getByRole("switch", { name: "Activate Last minute escape" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(settings.promotions[0].tiers).toEqual(originalTiers);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Edit Early bird" }).click();
  const birdEditor = page.getByRole("dialog", { name: "Edit early bird promotion" });
  await birdEditor.getByRole("radio", { name: "60+ days", exact: true }).locator("..").click();
  await expect(birdEditor.getByRole("radio", { name: "60+ days", exact: true })).toBeChecked();
  const firstRoom = birdEditor
    .getByRole("group", { name: "Applicable rooms" })
    .getByRole("checkbox")
    .nth(1);
  await firstRoom.locator("..").click();
  await expect(firstRoom).toBeChecked();
  await expect(
    birdEditor.getByRole("checkbox", { name: "All rooms", exact: true }),
  ).not.toBeChecked();
  await birdEditor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Book 60+ days ahead", { exact: true })).toBeVisible();
  expect(settings.promotions.find((p: any) => p.type === "EARLY_BIRD").roomTypeIds).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Midweek getaway", exact: true }) })
    .getByRole("button", { name: "Delete Midweek getaway", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "New promotion", exact: true })).toBeVisible();
  await testInfo.attach("promotions-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await testInfo.attach("promotions-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.goto("/booking-flow");
  await expect(page.getByRole("button", { name: /^Last-Minute$/ })).toHaveCount(0);
  await healthy();
  await noLegacy();
});

test("shows the empty state and a keyboard-friendly type menu styled like New promo code", async ({
  page,
}, testInfo) => {
  test.skip(process.env.E2E_BOOKING_ADMIN_PROD !== "1", "Requires production booking-admin build.");
  const healthy = watchPageHealth(page, testInfo);
  await mockBookingAdminBookingFlow(page);
  await page.route(`**${BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH}*`, (route) =>
    route.fulfill({
      json: { enabled: false, stackWithPromo: false, tiers: [], updatedAt: "2026-09-05T10:00:00Z" },
    }),
  );
  await page.goto("/promo-codes");
  await expect(page.getByRole("heading", { name: "No promotions yet" })).toBeVisible();

  // VAY-2234: both create buttons look the same, and the section title matches the page title.
  const look = (name: string) =>
    page.getByRole("button", { name, exact: true }).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.height, style.fontSize, style.borderRadius];
    });
  expect(await look("New promotion")).toEqual(await look("New promo code"));
  const titleSize = (name: string) =>
    page
      .getByRole("heading", { name, exact: true })
      .evaluate((element) => getComputedStyle(element).fontSize);
  expect(await titleSize("Promotions")).toBe(await titleSize("Promos"));

  const button = page.getByRole("button", { name: "New promotion", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(4);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.click();
  await page.getByRole("menuitem", { name: /^Last minute/ }).click();
  const dialog = page.getByRole("dialog", { name: "New last minute promotion" });
  await expect(dialog.getByRole("radio", { name: "Next 5 days", exact: true })).toBeFocused();
  await expect(dialog).toContainText(
    "Guests will see: Last minute escape — 10% off · Check-in within 5 days",
  );
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    accessibility.violations
      .filter(({ impact }) => impact === "critical" || impact === "serious")
      .map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();

  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await button.click();
  const menu = await page.getByRole("menu").boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  await healthy();
});
