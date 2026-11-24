import { expect, test } from "@playwright/test";
import {
  PMS_WEB_OWNER_PERMISSIONS,
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
  // VAY-2348: "Awaiting payment", the deadline banner, and the confirmation naming the money.
  await expect(page.getByText("Awaiting payment").first()).toBeVisible();
  await expect(page.getByText("Waiting for the bank transfer")).toBeVisible();
  await page.getByRole("button", { name: "Mark transfer received" }).first().click();
  await expect(
    page.getByText(
      "Mark the transfer of €360.00 from Ada Lovelace (reference VAY-ADA) as received?",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark received" }).click();
  await expect.poll(() => paid).toBe(true);
  await expect(page.getByText(/The guest pays you directly/)).toHaveCount(0);
  expect(accepts).toBe(0);
  await assertHealthy();
});

// VAY-2575: confirming a booking-page bank transfer is the owner's. Staff without the owner key see
// the booking awaiting payment, no confirm button, and who can confirm it.
test("leaves a bank transfer's confirmation to the owner for staff without the owner key", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let markPaidCalls = 0;
  const deadline = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-front-desk-membership",
        roleKey: "front_desk",
        permissions: PMS_WEB_OWNER_PERMISSIONS.filter(
          (permission) => permission !== "pms.operations.manage",
        ),
      },
    }),
  );
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        item: {
          ...pmsWebReservation,
          status: "pending_payment",
          pricing: {
            totalAmount: { amountDecimal: "360.00", currency: "EUR" },
            balanceAmount: { amountDecimal: "360.00", currency: "EUR" },
          },
          payment: { method: "bank_transfer", expectedMethod: "bank_transfer", status: "unpaid" },
          hostResponseDeadlineAt: deadline,
          awaitingHotelPaymentConfirmation: true,
        },
      },
    }),
  );
  await page.route(`${base}/mark-paid`, (route) => {
    markPaidCalls += 1;
    return route.fulfill({ status: 403, json: { code: "missing_permission" } });
  });

  // The calendar card's link lands here with ?confirm=payment; it must not ask either.
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}?confirm=payment`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page.getByText("Awaiting payment").first()).toBeVisible();
  await expect(page.getByText("Only the account owner can confirm this payment.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark transfer received" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark received" })).toHaveCount(0);
  expect(markPaidCalls).toBe(0);
  await assertHealthy();
});
