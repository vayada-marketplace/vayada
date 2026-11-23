import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2099: a request-mode hotel confirms each booking-page booking itself. A pay-at-property
// request waits for the hotel's answer, not for a payment: the page says what accepting does,
// offers Accept and Reject, and Accept confirms the booking.
test("asks the hotel to accept or reject a pay-at-property request, and accepts it", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let accepted = false;
  const deadline = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  const reservation = () => ({
    ...pmsWebReservation,
    status: accepted ? "confirmed" : "pending_payment",
    pricing: {
      totalAmount: { amountDecimal: "360.00", currency: "EUR" },
      balanceAmount: { amountDecimal: "360.00", currency: "EUR" },
    },
    payment: { method: "pay_at_property", expectedMethod: "pay_at_property", status: "unpaid" },
    ...(accepted ? {} : { hostResponseDeadlineAt: deadline }),
  });

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(base, (route) => route.fulfill({ json: { item: reservation() } }));
  await page.route(`${base}/accept`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.commandId).toEqual(expect.any(String));
    expect(body.idempotencyKey).toEqual(expect.any(String));
    accepted = true;
    return route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        reservation: reservation(),
      },
    });
  });

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page.getByText("Action Required")).toBeVisible();
  await expect(
    page.getByText("Accept the request to confirm the booking with payment due at the property."),
  ).toBeVisible();
  // Not a bank transfer or PayPal booking: no payment wording, no "mark paid".
  await expect(page.getByText(/manual-payment/)).toHaveCount(0);
  await expect(page.getByText("Awaiting payment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Mark .*(paid|received)/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject request" })).toBeVisible();

  await page.getByRole("button", { name: "Accept Booking" }).click();
  await expect(
    page.getByText("Accept this booking request? Payment will remain due at the property."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Accept Booking" })).toHaveCount(0);
  await expect(page.getByText("Action Required")).toHaveCount(0);
  await assertHealthy();
});
