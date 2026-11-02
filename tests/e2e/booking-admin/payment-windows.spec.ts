import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_WINDOWS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

// VAY-2348: when guests booking a given time before arrival can pay each way. Since VAY-2424 the
// booking time is chosen in Step 1, from the mockup's presets: with online card switched off, pay
// at the hotel from 14 days and bank transfer from 7 days leave guests booking under 7 days ahead
// no way to pay.
test("sets when guests can choose each way to pay and warns about a gap", async ({
  page,
}, testInfo) => {
  test.skip(
    !PROD,
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "finance-route-contracts.v1",
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        paymentSettings: {
          paymentsEnabled: true,
          paymentProvider: "stripe",
          acceptedMethods: ["pay_at_property", "cash", "manual_card", "bank_transfer"],
          defaultCurrency: "EUR",
          supportedCurrencies: ["EUR"],
          requiresManualReview: false,
          providerAccount: {
            providerAccountId: null,
            provider: null,
            status: "not_configured",
            onboardingStatus: "not_started",
            chargesEnabled: false,
            payoutsEnabled: false,
            capabilities: [],
          },
        },
      },
    }),
  );
  // Bank transfer is offered only with saved bank details.
  await page.route(
    `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/bank-transfer-destination`,
    (route) =>
      route.fulfill({
        json: {
          destination: {
            id: BOOKING_ADMIN_PROPERTY_ID,
            revision: 1,
            version: 1,
            enabled: true,
            deleted: false,
            maskedAccount: "•••• 3000",
          },
        },
      }),
  );
  const writes: unknown[] = [];
  // VAY-2424: the windows save with the page; untouched methods send no settings write.
  const settingsWrites: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/payment-settings"))
      settingsWrites.push(request.postDataJSON());
  });
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_WINDOWS_PATH}`, async (route) => {
    const body =
      route.request().method() === "PUT"
        ? (route.request().postDataJSON() as { windows: Record<string, unknown> })
        : { windows: {} };
    if (route.request().method() === "PUT") writes.push(body);
    await route.fulfill({
      json: { propertyId: BOOKING_ADMIN_PROPERTY_ID, paymentDeadlineHours: 48, ...body },
    });
  });

  await page.goto("/settings/payments");
  const card = page.getByRole("region", { name: "When guests can pay each way" });
  await expect(card).toBeVisible();
  // VAY-2424: a way to pay guests aren't offered has no lane, and no "Not offered" line either.
  await expect(card.getByText(/^Not offered to guests/)).toHaveCount(0);
  await expect(card.getByText("Credit card", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Fixed rule: guests have 48 hours to pay")).toBeVisible();
  // One save bar for the whole page (VAY-2424): nothing to save yet.
  await expect(card.getByRole("button", { name: /save/i })).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeDisabled();

  const hotel = page.getByLabel("When guests can choose Pay at hotel", { exact: true });
  const bank = page.getByLabel("When guests can choose Bank transfer", { exact: true });
  // Credit card is off: its booking time can't be chosen.
  await expect(
    page.getByLabel("When guests can choose Credit card", { exact: true }),
  ).toBeDisabled();
  // D7: bank transfer needs more than its 48-hour payment deadline, so 48 hours isn't offered.
  await expect(bank.locator("option")).toHaveText([
    "Any time",
    "7 days+ before arrival",
    "14 days+ before arrival",
    "30 days+ before arrival",
  ]);
  await hotel.selectOption({ label: "14 days+ before arrival" });
  await bank.selectOption({ label: "7 days+ before arrival" });

  await expect(
    card.getByText("Guests booking less than 7 days before arrival have no way to pay."),
  ).toBeVisible();
  await expect(card.getByTestId("payment-windows-strip").getByText("No way to pay")).toBeVisible();

  await save.click();
  await expect(page.getByText("Payment settings saved", { exact: true })).toBeVisible();
  expect(writes).toEqual([
    {
      windows: {
        pay_at_property: { kind: "at_least", amount: 14, unit: "days" },
        bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
      },
    },
  ]);
  expect(settingsWrites).toEqual([]);
  await expect(save).toBeDisabled();

  // Discard puts an unsaved edit back to what was saved.
  await hotel.selectOption({ label: "Any time" });
  await expect(page.getByText("You have unsaved changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(hotel).toHaveValue("14");
  await expect(save).toBeDisabled();

  // A way to pay that is switched off has no booking time to choose.
  await page.getByRole("switch", { name: "Offer Pay at hotel" }).click();
  await expect(hotel).toBeDisabled();
  await page.getByRole("button", { name: "Discard", exact: true }).click();

  // The card shows what guests are offered: switching Credit card on in Step 1 changes nothing
  // here until it is saved with Stripe connected.
  await page.getByRole("switch", { name: "Offer Credit card" }).click();
  await expect(
    page.getByLabel("When guests can choose Credit card", { exact: true }),
  ).toBeEnabled();
  await expect(card.getByText("Credit card", { exact: true })).toHaveCount(0);
  await expect(card.getByText(/have no way to pay\.$/)).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hotel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // A way to pay switched on but not ready yet (no Stripe account) still saves its booking time.
  await page
    .getByLabel("When guests can choose Credit card", { exact: true })
    .selectOption({ label: "7 days+ before arrival" });
  await save.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({
    windows: {
      card: { kind: "at_least", amount: 7, unit: "days" },
      pay_at_property: { kind: "at_least", amount: 14, unit: "days" },
      bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
    },
  });
  await assertHealthy();
});
