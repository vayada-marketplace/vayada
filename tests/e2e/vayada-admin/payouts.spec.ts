import { expect, test } from "@playwright/test";
import {
  amed,
  amedDetail,
  api,
  fulfillJson,
  mockPayouts,
  replacedFixture,
  signIn,
  startedPayoutId,
  ubud,
  uluwatu,
} from "./payoutsFixtures";

// VAY-2442 P5: Vayada finance pays vayada Payment hotels by hand on Mondays, for stays checked out
// by the Sunday before: a payout is started before the money moves, then marked sent. The page
// says so while vayada Payment is switched off.

test("finance starts a payout before sending, then marks it sent (VAY-2442)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await mockPayouts(page, origin);
  let started: Record<string, unknown> | null = null;
  let sent: Record<string, unknown> | null = null;
  await page.route(api(`/api/finance/platform/vayada-payment/payouts/${ubud}`), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return fulfillJson(route, origin, { payoutId: startedPayoutId }, 201);
  });
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${ubud}/${startedPayoutId}/sent`),
    (route) => {
      sent = route.request().postDataJSON();
      return fulfillJson(route, origin, { sent: true });
    },
  );
  await page.goto(new URL("/dashboard/payouts", adminBaseURL).toString());

  await expect(page.getByRole("link", { name: "Payouts", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
  await expect(page.getByText("stays checked out by Sun 8 Nov 2026")).toBeVisible();
  const table = page.locator("table");
  const row = (name: RegExp) => table.getByRole("row", { name });
  await expect(row(/Villa Lumbung Ubud/)).toContainText("IDR 1,250,000");
  await expect(row(/Ella Rock Cabins/)).toContainText("Owes LKR 4,500.00");
  await expect(row(/Canggu Surf House/)).toContainText("No payout account");
  // Started but not marked sent: finish it, never start another.
  await expect(row(/Kandy Hills Retreat/)).toContainText("Being sent: LKR 184,500.00");
  await expect(
    row(/Kandy Hills Retreat/).getByRole("button", { name: "Finish payout" }),
  ).toBeVisible();
  // No account, nothing owed or owing: nothing to pay.
  for (const name of [/Canggu Surf House/, /Ella Rock Cabins/, /Sidemen Rice Terraces/])
    await expect(row(name).getByRole("button")).toHaveCount(0);

  await row(/Villa Lumbung Ubud/)
    .getByRole("button", { name: "Pay", exact: true })
    .click();
  const dialog = page.getByRole("heading", { name: "Pay hotel" }).locator("../..");
  await expect(dialog).toContainText("IDR 1,250,000");
  await dialog.getByRole("button", { name: "Start payout of IDR 1,250,000" }).click();
  // Only now the bank details to send to, for the account the payout was started for.
  const sendDialog = page.getByRole("heading", { name: "Send payout" }).locator("../..");
  await expect(sendDialog).toContainText("8730 1122 6789");
  expect(started).toMatchObject({
    mode: "live",
    currency: "IDR",
    cutoff: "2026-11-08",
    amountMinor: "125000000",
    destinationId: "d0000000-0000-4000-8000-000000006789",
  });
  const submit = sendDialog.getByRole("button", { name: "Mark as sent" });
  await expect(submit).toBeDisabled();
  await sendDialog.getByPlaceholder("Wise transfer ID or bank reference").fill("WISE-48344120");
  await sendDialog.getByLabel("Paid on").fill("2026-11-09");
  await expect(submit).toBeDisabled();
  await sendDialog.getByLabel(/I sent exactly IDR 1,250,000 to the account ending 6789/).check();
  await submit.click();
  await expect(page.getByText("Paid IDR 1,250,000 to Villa Lumbung Ubud.")).toBeVisible();
  expect(sent).toEqual({ reference: "WISE-48344120", paidOn: "2026-11-09" });
});

test("a balance that changed meanwhile is never started as a partial payout (VAY-2442)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await mockPayouts(page, origin);
  await page.route(api(`/api/finance/platform/vayada-payment/payouts/${ubud}`), (route) =>
    route.request().method() === "POST"
      ? fulfillJson(
          route,
          origin,
          {
            statusCode: 409,
            code: "payout_amount_changed",
            message: "What the hotel is owed changed.",
            payNowMinor: "110000000",
          },
          409,
        )
      : route.fallback(),
  );
  await page.goto(new URL("/dashboard/payouts", adminBaseURL).toString());
  await page
    .locator("table")
    .getByRole("row", { name: /Villa Lumbung Ubud/ })
    .getByRole("button", { name: "Pay", exact: true })
    .click();
  const dialog = page.getByRole("heading", { name: "Pay hotel" }).locator("../..");
  await dialog.getByRole("button", { name: /Start payout/ }).click();
  await expect(dialog).toContainText(
    "What Villa Lumbung Ubud is owed changed to IDR 1,100,000. Close this and check again",
  );
});

test("a hotel's lines and payouts, and a payout the bank sent back (VAY-2442)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await mockPayouts(page, origin);
  let returned: Record<string, unknown> | null = null;
  await page.route(
    api(
      `/api/finance/platform/vayada-payment/payouts/${ubud}/aaaaaaaa-0000-4000-8000-000000000001/returned`,
    ),
    (route) => {
      returned = route.request().postDataJSON();
      return fulfillJson(route, origin, { returned: true });
    },
  );
  await page.goto(new URL("/dashboard/payouts", adminBaseURL).toString());
  await page
    .locator("table")
    .getByRole("row", { name: /Villa Lumbung Ubud/ })
    .click();
  await expect(page.getByRole("heading", { name: "Villa Lumbung Ubud" })).toBeVisible();
  await expect(page.getByText("Kept for later")).toBeVisible();
  await expect(page.getByRole("row", { name: /VAY-3MZ81C/ }).first()).toContainText("Refund");
  await page.getByRole("button", { name: "Mark returned" }).click();
  await page.getByPlaceholder("For example: account closed").fill("Account closed");
  await page.getByRole("button", { name: "Mark returned" }).last().click();
  await expect.poll(() => returned).toMatchObject({ reason: "Account closed" });
});

test("a replaced bank account waits for staff approval; card payments go on (VAY-2442 P7)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await mockPayouts(page, origin, replacedFixture);
  let approved: Record<string, unknown> | null = null;
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${uluwatu}/destination/reveal`),
    (route) =>
      fulfillJson(route, origin, {
        destinationId: "d0000000-0000-4000-8000-000000004321",
        countryCode: "ID",
        accountHolder: "PT Uluwatu Tebing Indah",
        accountNumber: "1180 0045 4321",
        bankName: "Bank Mandiri",
        bankCode: "008",
        branchCode: "",
        bicSwift: "",
        holderAddress: "",
      }),
  );
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${uluwatu}/destination/approve`),
    (route) => {
      approved = route.request().postDataJSON();
      return fulfillJson(route, origin, { approved: true, approvedAt: "2026-11-09T08:00:00Z" });
    },
  );
  await page.goto(new URL("/dashboard/payouts", adminBaseURL).toString());
  const row = (name: RegExp) => page.locator("table").getByRole("row", { name });
  await expect(row(/Uluwatu Cliff Villa/)).toContainText("New bank account – needs approval");
  // Owed money, but no "Pay" until the new account is approved.
  await expect(
    row(/Uluwatu Cliff Villa/).getByRole("button", { name: "Pay", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("1 waiting for bank account approval")).toBeVisible();

  await row(/Uluwatu Cliff Villa/)
    .getByRole("button", { name: "Approve bank account" })
    .click();
  const dialog = page.getByRole("heading", { name: "Approve bank account" }).locator("../..");
  await expect(dialog).toContainText(
    "Uluwatu Cliff Villa replaced its bank account on 2 Nov 2026. Check it before any payout goes to it.",
  );
  await expect(dialog.getByText("Replaced", { exact: true })).toBeVisible();
  // Approving needs a look at the details (audited) and the operator's check.
  const approve = dialog.getByRole("button", { name: "Approve bank account" });
  await dialog.getByLabel("I checked that this account belongs to Uluwatu Cliff Villa.").check();
  await expect(approve).toBeDisabled();
  await dialog.getByRole("button", { name: "Show bank details" }).click();
  await expect(dialog).toContainText("1180 0045 4321");
  await approve.click();
  await expect(
    page.getByText(
      "Approved the bank account ending 4321 for Uluwatu Cliff Villa. Payouts can go to it now.",
    ),
  ).toBeVisible();
  expect(approved).toEqual({ destinationId: "d0000000-0000-4000-8000-000000004321" });
});

test("a payout started before the hotel replaced its account never shows the new one (VAY-2442 P7)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await mockPayouts(page, origin, replacedFixture);
  let revealed = 0;
  await page.route(api(`/api/finance/platform/vayada-payment/payouts/${amed}`), (route) =>
    route.request().method() === "GET" ? fulfillJson(route, origin, amedDetail) : route.fallback(),
  );
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${amed}/destination/reveal`),
    (route) => {
      revealed += 1;
      return fulfillJson(route, origin, {});
    },
  );
  await page.goto(new URL(`/dashboard/payouts/${amed}`, adminBaseURL).toString());
  await expect(page.getByRole("heading", { name: "Amed Reef Bungalows" })).toBeVisible();
  await expect(page.getByText("New bank account – needs approval")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve bank account" })).toBeVisible();
  // An unapproved account's details open only inside "Approve bank account".
  await expect(page.getByRole("button", { name: "Show bank details" })).toHaveCount(0);
  await expect(
    page.getByText("The hotel replaced this bank account after this payout was started.").first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Finish payout of IDR 395,000" }).click();
  const dialog = page.getByRole("heading", { name: "Send payout" }).locator("../..");
  await expect(dialog).toContainText(
    "The hotel replaced this bank account after this payout was started. If the money hasn't gone out, cancel it",
  );
  await expect(
    dialog.getByLabel("I sent exactly IDR 395,000 to the account this payout was started for."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Not sent? Cancel" })).toBeVisible();
  // The new, unapproved account's details are never opened for this payout.
  expect(revealed).toBe(0);
  await expect(dialog).not.toContainText("8888");
});

test("says so while vayada Payment is switched off (VAY-2442)", async ({ page, baseURL }) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await page.route(api("/api/finance/platform/vayada-payment/payouts"), (route) =>
    fulfillJson(route, origin, { statusCode: 404, message: "Not Found" }, 404),
  );
  await page.goto(new URL("/dashboard/payouts", adminBaseURL).toString());
  await expect(page.getByText("vayada Payment is switched off.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay", exact: true })).toHaveCount(0);
});
