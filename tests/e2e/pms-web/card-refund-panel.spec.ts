import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2205 P1.7: a cancelled card stay shows its refund to the guest's card under Payment, and
// staff can ask Stripe again when it failed (Paper "VAY-2205 card refunds + card switch",
// approved by Flamur on 2026-10-18).
const refund = {
  status: "failed",
  amount: "80.50",
  currency: "EUR",
  requestedBy: "guest",
  failureReason: "expired_or_canceled_card",
  createdAt: "2026-10-18T09:14:00.000Z",
  settledAt: "2026-10-18T09:15:00.000Z",
};
const cancelled = (cardRefund: typeof refund) => ({
  ...pmsWebReservation,
  status: "canceled",
  pricing: {
    totalAmount: { amountDecimal: "322.00", currency: "EUR" },
    balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
  },
  payment: { method: "card", expectedMethod: "card", status: "paid" },
  cardRefund,
});

test("a failed card refund says why and is retried after a confirm (VAY-2205)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  let current = refund;
  await page.route(base, (route) => route.fulfill({ json: { item: cancelled(current) } }));
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  const retries: Array<{ idempotencyKey: string }> = [];
  await page.route(`${base}/host-actions/card-refund-retry`, (route) => {
    retries.push(route.request().postDataJSON());
    current = { ...refund, status: "pending", failureReason: null, settledAt: null };
    return route.fulfill({ json: { status: "pending" } });
  });

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const panel = page.getByRole("region", { name: "The refund to the guest's card failed" });
  await expect(
    panel.getByText(/€80\.50 of €322\.00 · .* · The guest's card has expired or was cancelled\./),
  ).toBeVisible();
  await expect(panel.getByText("Failed", { exact: true })).toBeVisible();
  await page
    .getByText("Payment", { exact: true })
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));

  await page.screenshot({ path: testInfo.outputPath("refund-failed.png") });

  await panel.getByRole("button", { name: "Retry refund" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry the refund?" });
  await expect(
    dialog.getByText(
      "We ask Stripe again to send €80.50 back to Ada Lovelace's card. Nothing new is charged, and the guest gets one refund at most.",
    ),
  ).toBeVisible();
  await page
    .getByText("Payment", { exact: true })
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));

  await page.screenshot({ path: testInfo.outputPath("refund-retry-confirm.png") });
  expect(retries).toHaveLength(0);
  await dialog.getByRole("button", { name: "Retry refund" }).click();

  const pending = page.getByRole("region", { name: "Refund on its way to the guest's card" });
  await expect(pending.getByText(/€80\.50 of €322\.00 · the guest cancelled on/)).toBeVisible();
  await expect(pending.getByRole("button")).toHaveCount(0);
  expect(retries).toEqual([{ idempotencyKey: expect.any(String) }]);
  await page
    .getByText("Payment", { exact: true })
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));

  await page.screenshot({ path: testInfo.outputPath("refund-pending.png") });
  await assertHealthy();
});

test("a retry the API refuses says so and leaves the refund failed (VAY-2205)", async ({
  page,
}) => {
  // No page-health check: the refused retry logs its 503 as a console error.
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  await page.route(base, (route) => route.fulfill({ json: { item: cancelled(refund) } }));
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(`${base}/host-actions/card-refund-retry`, (route) =>
    route.fulfill({ status: 503, json: { message: "Card refunds are unavailable." } }),
  );
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const panel = page.getByRole("region", { name: "The refund to the guest's card failed" });
  await panel.getByRole("button", { name: "Retry refund" }).click();
  await page
    .getByRole("dialog", { name: "Retry the refund?" })
    .getByRole("button", { name: "Retry refund" })
    .click();
  await expect(panel.getByRole("alert")).toHaveText(
    "The refund couldn't be retried. Try again in a moment.",
  );
});

test("a refunded card stay says what went back and who cancelled (VAY-2205)", async ({
  page,
}, testInfo) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        item: cancelled({
          ...refund,
          status: "succeeded",
          requestedBy: "host",
          failureReason: null,
        }),
      },
    }),
  );
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const panel = page.getByRole("region", { name: "Refunded to the guest's card" });
  await expect(panel.getByText(/€80\.50 of €322\.00 · .* · you cancelled/)).toBeVisible();
  await expect(
    panel.getByText(
      "Stripe keeps its processing fee. vayada's commission on the €80.50 went back to you.",
    ),
  ).toBeVisible();
  await page
    .getByText("Payment", { exact: true })
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));

  await page.screenshot({ path: testInfo.outputPath("refund-done.png") });
});
