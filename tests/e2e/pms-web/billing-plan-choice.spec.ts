import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2171: a hotel that never chose a plan was shown "Commission · CURRENT" with no way to
// choose it. Billing now says no plan is chosen and offers the choice.
async function setup(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const choices: unknown[] = [];
  const overview = () => ({
    contractVersion: "finance-billing.v1",
    propertyId: PMS_WEB_PROPERTY_ID,
    planStatus: {
      plan: choices.length ? "commission" : null,
      status: choices.length ? "commission" : "not_selected",
      currency: "EUR",
      activeRoomCount: 2,
      amountMinor: 3_500,
      fixedPlanAvailable: true,
      nextBillingDate: null,
      checkoutPending: false,
      customerPortalAvailable: false,
    },
    paymentMethod: "card",
    savedCard: null,
    billingDetails: { companyName: "", billingEmail: "", taxId: null },
    invoices: [],
  });
  await page.route(`**/api/finance/properties/${PMS_WEB_PROPERTY_ID}/billing`, (route) =>
    route.fulfill({ json: overview() }),
  );
  await page.route(
    `**/api/finance/properties/${PMS_WEB_PROPERTY_ID}/select-commission`,
    (route) => {
      choices.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        json: { contractVersion: "finance-subscriptions.v1", planStatus: overview().planStatus },
      });
    },
  );
  return choices;
}

test("a hotel without a plan chooses Commission in Billing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const choices = await setup(page);
  await page.goto("/settings/billing");

  const main = page.locator("main");
  await expect(
    main.getByText(
      "You haven’t chosen a plan yet. Guests can’t book on your booking page until you do.",
    ),
  ).toBeVisible();
  await expect(main.getByText("CURRENT", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Choose this plan" })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("billing-not-chosen.png") });

  await main.getByRole("button", { name: "Choose this plan" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm billing plan switch" });
  await expect(dialog.getByRole("heading", { name: "Choose the Commission plan?" })).toBeVisible();
  await expect(
    dialog.getByText(
      "You pay 5% per direct booking. No monthly fee. You can switch plans anytime.",
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Choose Commission" }).click();

  await expect(
    main.getByText("Your Commission plan is active. Direct bookings use the 5% rate."),
  ).toBeVisible();
  await expect(main.getByText("CURRENT", { exact: true })).toHaveCount(1);
  await expect(main.getByRole("button", { name: "Your current plan" })).toBeDisabled();
  await expect(main.getByText("You haven’t chosen a plan yet.", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("billing-commission-chosen.png") });
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({ commandId: expect.stringMatching(/^commission-select-/) });
});
