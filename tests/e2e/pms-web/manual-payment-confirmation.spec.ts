import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2139: a booking-page bank transfer waits for the guest's payment; the hotel's one step is
// confirming that the money arrived, not accepting the booking.
test("confirms a bank transfer from the booking page instead of accepting it", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let paid = false;
  let accepts = 0;
  const deadline = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
  const reservation = () => ({
    ...pmsWebReservation,
    status: paid ? "confirmed" : "pending_payment",
    pricing: {
      totalAmount: { amountDecimal: "360.00", currency: "EUR" },
      balanceAmount: { amountDecimal: paid ? "0.00" : "360.00", currency: "EUR" },
    },
    payment: {
      method: "bank_transfer",
      expectedMethod: "bank_transfer",
      status: paid ? "paid" : "unpaid",
    },
    ...(paid ? {} : { hostResponseDeadlineAt: deadline, awaitingHotelPaymentConfirmation: true }),
  });

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) => route.fulfill({ json: { item: reservation() } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/accept`,
    (route) => {
      accepts += 1;
      return route.fulfill({ status: 409, json: { code: "invalid_status_transition" } });
    },
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/mark-paid`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.commandId).toEqual(expect.any(String));
      expect(body.idempotencyKey).toEqual(expect.any(String));
      paid = true;
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          reservation: reservation(),
        },
      });
    },
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page.getByText(/The guest pays you directly/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept Booking" })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark bank transfer received" }).first().click();
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect.poll(() => paid).toBe(true);
  await expect(page.getByText(/The guest pays you directly/)).toHaveCount(0);
  expect(accepts).toBe(0);
  await assertHealthy();
});
