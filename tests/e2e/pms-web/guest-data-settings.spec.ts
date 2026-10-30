import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebGuestDataSettings,
} from "../support/pmsWebMocks";
import { mockCheckinFlow } from "../support/checkinFlowMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2420: Settings › Guest data (Timo's mockup 3), and what it changes at check-in.
const SETTINGS = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guest-data-settings`;

test("saves each guest data change at once, and keeps email on (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const saved: unknown[] = [];
  let current = structuredClone(pmsWebGuestDataSettings);
  await page.route(SETTINGS, (route) => {
    if (route.request().method() === "PUT") {
      current = route.request().postDataJSON();
      saved.push(current);
    }
    return route.fulfill({ json: { settings: current, canManage: true } });
  });

  await page.goto("/settings/guest-data");
  await expect(page.getByRole("heading", { name: "Guest fields" })).toBeVisible();
  await expect(page.getByText("Changes save automatically")).toBeVisible();
  // First and last name are always required; email can't be switched off.
  const firstName = page.getByRole("radiogroup", { name: "First name status" });
  await expect(firstName.getByRole("radio", { name: "Required" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(firstName.getByRole("radio", { name: "Off" })).toBeDisabled();
  await expect(
    page.getByRole("radiogroup", { name: "Email status" }).getByRole("radio", { name: "Off" }),
  ).toBeDisabled();

  await page
    .getByRole("radiogroup", { name: "Phone status" })
    .getByRole("radio", { name: "Off" })
    .click();
  await page.getByRole("switch", { name: "Same email address" }).click();
  // Deleting documents sooner asks first: past guests' documents go within the hour.
  await page.getByRole("combobox", { name: "Delete identity documents" }).selectOption("30");
  await expect(page.getByRole("alert")).toContainText("deleted within the hour");
  await expect.poll(() => saved.length).toBe(2);
  await page.getByRole("button", { name: "Delete after 30 days" }).click();
  await expect.poll(() => saved.length).toBe(3);
  expect(saved.at(-1)).toEqual({
    fields: { ...pmsWebGuestDataSettings.fields, phone: "off" },
    matching: { email: false, phone: true },
    identityRetentionDays: 30,
  });
  await expect(page.getByText("Changes save automatically")).toBeVisible();
  await assertHealthy();
});

test("shows guest data read-only to staff who aren't the owner (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(SETTINGS, (route) =>
    route.fulfill({ json: { settings: pmsWebGuestDataSettings, canManage: false } }),
  );
  await page.goto("/settings/guest-data");
  await expect(page.getByText("Only the owner can change these settings.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Same phone number" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Delete identity documents" })).toBeDisabled();
  await assertHealthy();
});

test("check-in leaves out a field set to Off and asks for a required one (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.route(SETTINGS, (route) =>
    route.fulfill({
      json: {
        settings: {
          ...pmsWebGuestDataSettings,
          fields: { ...pmsWebGuestDataSettings.fields, phone: "off", email: "required" },
        },
        canManage: true,
      },
    }),
  );
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const main = page.locator("main").first();
  await main.getByRole("button", { name: "Confirm arrival" }).click();
  await main.getByRole("button", { name: /^Edit Ada Lovelace/ }).click();
  const ada = main.getByRole("form", { name: "Ada Lovelace" });
  await expect(ada.getByRole("textbox", { name: /Email \*/ })).toBeVisible();
  await expect(ada.getByRole("textbox", { name: /Phone/ })).toHaveCount(0);
  // Email is asked of the lead guest only; Grace may leave it empty.
  await main.getByRole("button", { name: /^Add details Grace Hopper/ }).click();
  const grace = main.getByRole("form", { name: "Grace Hopper" });
  await expect(grace.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(grace.getByRole("textbox", { name: /Email \*/ })).toHaveCount(0);
  await expect(grace.getByRole("textbox", { name: /Phone/ })).toHaveCount(0);
  await assertHealthy();
});
