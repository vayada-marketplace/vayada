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

// VAY-2348: Payments › "When guests can pay each way". The ticket's example with online card
// switched off: pay at the hotel within 48 hours, bank transfer from 7 days, so guests booking
// 2-7 days ahead have no way to pay.
test("sets a booking window per way to pay and warns about a gap", async ({ page }, testInfo) => {
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
  const writes: unknown[] = [];
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
  await expect(card.getByText("Online Card is switched off above.")).toBeVisible();
  await expect(card.getByText("Fixed rule: guests have 48 hours to pay")).toBeVisible();
  const save = card.getByRole("button", { name: "Save booking windows" });
  await expect(save).toBeDisabled();

  await card.getByLabel("When Pay at Hotel is offered").selectOption("within");
  await card.getByLabel("Unit for Pay at Hotel").selectOption("hours");
  await card.getByLabel("Hours for Pay at Hotel").fill("48");
  await expect(card.getByText("Offered when guests book within 48 hours of arrival")).toBeVisible();

  // D7: bank transfer needs more than its 48-hour payment deadline.
  await card.getByLabel("When Bank Transfer is offered").selectOption("at_least");
  await card.getByLabel("Days for Bank Transfer").fill("2");
  await expect(card.getByText(/^Bank transfer needs at least 3 days/)).toBeVisible();
  await expect(save).toBeDisabled();
  await card.getByLabel("Days for Bank Transfer").fill("7");
  await expect(card.getByText(/^Bank transfer needs at least 3 days/)).toHaveCount(0);

  await expect(
    card.getByText("Guests booking between 48 hours and 7 days before arrival have no way to pay."),
  ).toBeVisible();
  await expect(card.getByTestId("payment-windows-strip").getByText("No way to pay")).toBeVisible();

  await save.click();
  await expect(card.getByText("Booking windows saved.")).toBeVisible();
  expect(writes).toEqual([
    {
      windows: {
        pay_at_property: { kind: "within", amount: 48, unit: "hours" },
        bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
      },
    },
  ]);
  await expect(save).toBeDisabled();

  // Switching online card on (not saved yet) covers the gap at once.
  await page.getByRole("button", { name: /^Online Card/ }).click();
  await expect(card.getByLabel("When Online Card is offered")).toHaveValue("any");
  await expect(card.getByText(/have no way to pay\.$/)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByLabel("Hours for Pay at Hotel")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await assertHealthy();
});
