import { expect, test } from "@playwright/test";
import { mockVayadaPayments } from "./vayadaPaymentsFixtures";

// VAY-2442 P6: Booking Admin › Payments with vayada Payment: the bank account Vayada pays the hotel
// out to. Only the owner adds, changes or removes it; vayada Payment shows only once switched on.
const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test("an owner adds the bank account vayada Payment pays out to, and removes it (VAY-2442)", async ({
  page,
}) => {
  test.skip(
    !PROD,
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  const { writes } = await mockVayadaPayments(page, { available: true });
  await page.goto("/settings/payments");

  const vayada = page.getByRole("button", { name: /vayada Payment/ });
  await expect(vayada).toBeEnabled();
  // Card is on with vayada Payment, but there's nowhere to pay the hotel out to yet.
  await expect(
    page.getByText("There's no bank account for vayada Payment to pay you out to yet."),
  ).toBeVisible();
  await expect(page.getByText(/pays you every Monday for stays that checked out/)).toBeVisible();
  await expect(page.getByText(/your plan fee plus 6% of each card payment/)).toBeVisible();

  const save = page.getByRole("button", { name: "Save bank account" });
  // Incomplete details are refused before anything is sent.
  await page.getByLabel("Account holder name").fill("PT Lumbung Ubud Lestari");
  await save.click();
  await expect(page.getByText(/Fill in every field that isn't marked optional/)).toBeVisible();
  expect(writes).toEqual([]);

  await page.getByLabel("Account number").fill("8730 1122 6789");
  await page.getByLabel("Bank name").fill("Bank Central Asia (BCA)");
  await save.click();
  await expect(page.getByText(/Fill in every field that isn't marked optional/)).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByLabel("Bank code").fill("014");
  await save.click();
  await expect(page.getByText("Bank account saved.")).toBeVisible();
  await expect(page.getByText("Indonesia · account •••• 6789")).toBeVisible();
  expect(writes[0]).toMatchObject({
    action: "replace",
    expectedVersion: 0,
    countryCode: "ID",
    details: {
      accountHolder: "PT Lumbung Ubud Lestari",
      accountNumber: "8730 1122 6789",
      bankName: "Bank Central Asia (BCA)",
      bankCode: "014",
    },
  });

  // Sri Lankan banks use a branch code instead.
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(
    page.getByText("Payouts go to the new account from the next payout on."),
  ).toBeVisible();
  await page.getByLabel("Country of the bank").selectOption("LK");
  await expect(page.getByLabel("Branch code")).toBeVisible();
  await expect(page.getByLabel("Bank code")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    page.getByText(/Guests can't pay by card until you add another one and Vayada has checked it/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(page.getByText("Bank account removed.")).toBeVisible();
  expect(writes[1]).toEqual({
    action: "delete",
    commandId: expect.any(String),
    expectedVersion: 1,
  });
  await expect(save).toBeVisible();
});

test("vayada Payment can't be chosen until it is switched on (VAY-2442)", async ({ page }) => {
  test.skip(
    !PROD,
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  await mockVayadaPayments(page, { available: false });
  await page.goto("/settings/payments");
  await expect(page.getByRole("button", { name: /vayada Payment/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save bank account" })).toHaveCount(0);
});

test("a hotel on Stripe chooses vayada Payment and saves it with the page (VAY-2442)", async ({
  page,
}) => {
  test.skip(
    !PROD,
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  const { writes, settingsWrites } = await mockVayadaPayments(page, {
    available: true,
    provider: "stripe",
  });
  await page.goto("/settings/payments");
  await page.getByRole("button", { name: /vayada Payment/ }).click();
  await expect(page.getByRole("button", { name: "Save bank account" })).toBeVisible();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => settingsWrites.length).toBe(1);
  expect(settingsWrites[0]).toMatchObject({
    paymentSettings: {
      paymentProvider: "vayada",
      acceptedMethods: expect.arrayContaining(["card"]),
    },
  });
  expect(writes).toEqual([]);
});

test("staff who aren't the owner see the payout account masked and can't change it (VAY-2442)", async ({
  page,
}) => {
  test.skip(
    !PROD,
    "Requires a production booking-admin build so the authenticated shell hydrates.",
  );
  await mockVayadaPayments(page, {
    available: true,
    destination: {
      id: "d0000000-0000-4000-8000-000000000001",
      revision: 1,
      version: 1,
      enabled: true,
      deleted: false,
      countryCode: "LK",
      maskedAccount: "•••• 4321",
    },
  });
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "booking-admin-manager-membership",
        roleKey: "hotel_manager",
        permissions: ["booking.settings.manage"],
      },
    }),
  );
  await page.goto("/settings/payments");
  await expect(page.getByText("Sri Lanka · account •••• 4321")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
});
