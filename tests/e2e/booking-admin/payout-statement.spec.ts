import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  mockPayoutStatement,
  mockVayadaPayments,
  PAYOUT_STATEMENT,
} from "./vayadaPaymentsFixtures";

// VAY-2584: Settings › Payouts shows the owner of a vayada Payment hotel what it is owed, each
// Monday payout and every line that adds to or takes from it.

test("the owner sees what is owed, each payout and every deduction, on desktop and phone", async ({
  page,
}, testInfo) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await mockPayoutStatement(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/payouts");

  await expect(page.getByRole("heading", { name: "Payouts", level: 1 })).toBeVisible();
  const totals = page.getByTestId("payout-totals");
  await expect(totals).toContainText("Next payout · Mon 30 Nov");
  await expect(totals).toContainText("IDR 18,450,000");
  await expect(totals).toContainText("For stays checking out by Sun 29 Nov, to •••• 6789.");
  await expect(totals).toContainText("IDR 34,100,000");

  const payouts = page.getByTestId("payout-row");
  await expect(payouts).toHaveCount(4);
  await expect(payouts.nth(2)).toContainText("Returned by the bank");

  const lines = page.getByTestId("statement-line");
  await expect(lines).toHaveCount(7);
  await expect(lines.nth(0)).toContainText("Card payment");
  await expect(lines.nth(0)).toContainText("2,752,000");
  await expect(lines.nth(0)).toContainText("your plan's booking fee (IDR 256,000)");
  await expect(lines.nth(3)).toContainText("−2,805,000");
  await expect(lines.nth(4)).toContainText("Answered dispute lost");
  await expect(lines.nth(5)).toContainText("+1,750,000");
  await expect(lines.nth(6)).toContainText("The Mon 9 Nov payout came back from the bank.");
  await page.screenshot({ path: testInfo.outputPath("payouts-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Deductions" }).click();
  await expect(lines).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Deductions" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(lines).toHaveCount(7);

  // Phone: every line still reads, nothing runs off the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lines.nth(0)).toContainText("2,752,000");
  await expect(lines.nth(0).getByText("Card payment", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("payouts-phone.png"), fullPage: true });
});

test("staff who aren't the owner are told payouts are the owner's; a hotel without payouts sees an empty state", async ({
  page,
}, testInfo) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await mockPayoutStatement(page, 403);
  await page.goto("/settings/payouts");
  await expect(page.getByTestId("payout-statement-owner-only")).toContainText(
    "Only the account owner can see payouts",
  );
  await expect(page.getByTestId("statement-line")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("payouts-staff.png"), fullPage: true });

  await page.unroute("**/payout-statement");
  await mockPayoutStatement(page, 404);
  await page.reload();
  const empty = page.getByTestId("payout-statement-empty");
  await expect(empty).toContainText("No payouts yet");
  await page.screenshot({ path: testInfo.outputPath("payouts-empty.png"), fullPage: true });
  await empty.getByRole("link", { name: "Go to Payments" }).click();
  await expect(page).toHaveURL(/\/settings\/payments$/);
});

test("Payments links the owner to the statement with the next payout", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.E2E_BOOKING_ADMIN_PROD !== "1",
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  await mockVayadaPayments(page, {
    available: true,
    statement: PAYOUT_STATEMENT,
    destination: {
      id: "d0000000-0000-4000-8000-000000000001",
      revision: 1,
      version: 1,
      enabled: true,
      deleted: false,
      countryCode: "ID",
      maskedAccount: "•••• 6789",
    },
  });
  await page.goto("/settings/payments");
  const link = page.getByTestId("payout-statement-link");
  await expect(link).toContainText("See payouts and statement");
  await expect(link).toContainText("Next payout Mon 30 Nov · IDR 18,450,000");
  await link.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("payments-link.png"), fullPage: true });
  await link.getByRole("link", { name: /See payouts and statement/ }).click();
  await expect(page).toHaveURL(/\/settings\/payouts$/);
  await expect(page.getByTestId("statement-line")).toHaveCount(7);
});
