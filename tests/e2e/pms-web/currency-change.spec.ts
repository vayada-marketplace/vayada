import { expect, test, type Page } from "@playwright/test";

import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2390 P5: the Owner's protected currency change on Settings › Property. The numbers stay
// (100 EUR becomes 100 CHF); the API refuses, with reasons, while bookings or channels need EUR.
// The dialog asks for those reasons when it opens; the change checks them again.
const SOURCE = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-source`;

async function mockCurrency(
  page: Page,
  answer: { status: number; json: unknown },
  preview: { status: number; json: unknown } = { status: 200, json: { blockers: [] } },
) {
  const writes: { body: unknown; key: string | undefined }[] = [];
  await page.route(SOURCE, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-pricing.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        pricingCurrency: {
          propertyId: PMS_WEB_PROPERTY_ID,
          currency: "EUR",
          pricingCurrencyRevision: 3,
        },
        flexibleRatePlans: [],
        capturedAt: "2026-10-28T12:00:00.000Z",
      },
    }),
  );
  await page.route(`${SOURCE}/currency-capabilities`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: ["CHF", "EUR", "GBP", "USD"].map((code) => ({ code, scale: 2 })),
      },
    }),
  );
  await page.route(`${SOURCE}/currency-change`, (route) => {
    writes.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    return route.fulfill(answer);
  });
  await page.route(`${SOURCE}/currency-change/blockers`, (route) => route.fulfill(preview));
  return writes;
}

async function openDialog(page: Page) {
  await page.goto("/settings/property#currency");
  const row = page.locator("#currency");
  await expect(row.getByText("EUR · Euro")).toBeVisible();
  await row.getByRole("button", { name: "Change currency" }).click();
}

async function openChange(page: Page) {
  await openDialog(page);
  const dialog = page.getByRole("dialog", { name: "Change your property currency" });
  await dialog.getByLabel("New currency").selectOption("CHF");
  return dialog;
}

const BLOCKED = {
  code: "pricing_currency_change_blocked",
  currentRevision: 3,
  blockers: [
    { code: "booking_reference", affectedCount: 3 },
    { code: "channel_connection", affectedCount: 1 },
  ],
};

test("lets the Owner change the currency, numbers kept, after typing the code", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const writes = await mockCurrency(page, {
    status: 200,
    json: {
      contractVersion: "pms-pricing.v1",
      outcome: "updated",
      pricingCurrency: {
        propertyId: PMS_WEB_PROPERTY_ID,
        currency: "CHF",
        pricingCurrencyRevision: 4,
      },
      acceptedAt: "2026-10-28T12:00:01.000Z",
    },
  });

  const dialog = await openChange(page);
  await expect(dialog).toContainText("Your price amounts stay the same numbers");
  await expect(dialog).toContainText("100 EUR becomes 100 CHF");
  await expect(dialog).toContainText("Past bookings, payments and reports stay in EUR.");
  const submit = dialog.getByRole("button", { name: "Change to CHF" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Type CHF to confirm").fill("chf");
  await submit.click();

  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toEqual({ expectedPricingCurrencyRevision: 3, currency: "CHF" });
  expect(writes[0]!.key).toBeTruthy();
  await expect(
    page.getByRole("status").filter({ hasText: "Your currency is now CHF." }),
  ).toBeVisible();
  await expect(page.locator("#currency").getByText("CHF · Swiss Franc")).toBeVisible();
});

test("says what blocks a change as the dialog opens, before anything is typed", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const writes = await mockCurrency(
    page,
    { status: 409, json: BLOCKED },
    { status: 200, json: { blockers: BLOCKED.blockers } },
  );

  await openDialog(page);

  const blocked = page.getByRole("dialog", { name: /You can.t change the currency right now/ });
  await expect(blocked).toContainText("Some bookings, booking sites or records are in EUR.");
  await expect(blocked).toContainText("3 upcoming bookings");
  await expect(blocked).toContainText("Booking sites connected");
  await expect(blocked.getByRole("link", { name: "View upcoming bookings" })).toHaveAttribute(
    "href",
    "/bookings",
  );
  await expect(blocked.getByLabel("New currency")).toHaveCount(0);
  await blocked.getByRole("button", { name: "OK" }).click();
  await expect(blocked).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await expect(page.locator("#currency").getByText("EUR · Euro")).toBeVisible();
});

test("still says what blocks a change the preview missed, and changes nothing", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  // A preview that can't answer leaves the reasons to the change, which checks them anyway.
  await mockCurrency(
    page,
    { status: 409, json: BLOCKED },
    { status: 503, json: { code: "unavailable" } },
  );

  const dialog = await openChange(page);
  await dialog.getByLabel("Type CHF to confirm").fill("CHF");
  await dialog.getByRole("button", { name: "Change to CHF" }).click();

  const blocked = page.getByRole("dialog", { name: /You can.t change the currency right now/ });
  await expect(blocked).toContainText("3 upcoming bookings");
  await expect(blocked).toContainText("Booking sites connected");
  await expect(blocked.getByRole("link", { name: "View upcoming bookings" })).toHaveAttribute(
    "href",
    "/bookings",
  );
  await blocked.getByRole("button", { name: "OK" }).click();
  await expect(blocked).toHaveCount(0);
  await expect(page.locator("#currency").getByText("EUR · Euro")).toBeVisible();
});

test("shows staff the currency without the change, which only the Owner can make", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-manager-membership",
        roleKey: "hotel_manager",
        permissions: [
          "pms.operations.read",
          "pms.operations.manage",
          "pms.settings.read",
          "pms.settings.manage",
        ],
      },
    }),
  );

  await page.goto("/settings/property#currency");
  await expect(page.locator("#currency").getByText("EUR · Euro")).toBeVisible();
  await expect(page.getByText("Only the account owner can change it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change currency" })).toHaveCount(0);
});
