import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2099: a request-mode hotel confirms each booking-page booking itself. A request waits for
// the hotel's answer, not for a payment: the page says what accepting does, offers Accept and
// Reject, and Accept confirms the booking. A card booking still inside its payment window (its
// payment deadline shows as the booking's deadline) has nothing to accept yet.
async function openPendingBooking(
  page: Page,
  payment: { method: string; expectedMethod: string; status: string },
  minutesLeft: number,
) {
  const state = { accepted: false, accepts: 0 };
  const deadline = new Date(Date.now() + minutesLeft * 60 * 1000).toISOString();
  const reservation = () => ({
    ...pmsWebReservation,
    status: state.accepted ? "confirmed" : "pending_payment",
    pricing: {
      totalAmount: { amountDecimal: "360.00", currency: "EUR" },
      balanceAmount: { amountDecimal: "360.00", currency: "EUR" },
    },
    payment,
    ...(state.accepted ? {} : { hostResponseDeadlineAt: deadline }),
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
    state.accepts += 1;
    state.accepted = true;
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
  return state;
}

const CARD_REQUEST = "Accept the request to capture the authorized card and confirm the booking.";
const AT_PROPERTY_REQUEST =
  "Accept the request to confirm the booking with payment due at the property.";
const WAITING_FOR_CARD =
  "Waiting for the guest's card payment. You can accept the request once the card is authorised.";

test("asks the hotel to accept or reject a pay-at-property request, and accepts it", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const state = await openPendingBooking(
    page,
    { method: "pay_at_property", expectedMethod: "pay_at_property", status: "unpaid" },
    23 * 60,
  );

  await expect(page.getByText("Action Required")).toBeVisible();
  await expect(page.getByText(AT_PROPERTY_REQUEST)).toBeVisible();
  // Not a bank transfer or PayPal booking: no payment wording, no "mark paid".
  await expect(page.getByText(/manual-payment/)).toHaveCount(0);
  await expect(page.getByText(CARD_REQUEST)).toHaveCount(0);
  await expect(page.getByText("Awaiting payment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Mark .*(paid|received)/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject request" })).toBeVisible();

  await page.getByRole("button", { name: "Accept Booking" }).click();
  await expect(
    page.getByText("Accept this booking request? Payment will remain due at the property."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => state.accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Accept Booking" })).toHaveCount(0);
  await expect(page.getByText("Action Required")).toHaveCount(0);
  await assertHealthy();
});

test("asks the hotel to accept a card request the guest authorised", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const state = await openPendingBooking(
    page,
    { method: "card", expectedMethod: "unknown", status: "authorized" },
    23 * 60,
  );

  await expect(page.getByText(CARD_REQUEST)).toBeVisible();
  await expect(page.getByText(AT_PROPERTY_REQUEST)).toHaveCount(0);
  await expect(page.getByText(/manual-payment/)).toHaveCount(0);
  await page.getByRole("button", { name: "Accept Booking" }).click();
  await expect(
    page.getByText("Accept this booking request and capture the guest's authorized card payment?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => state.accepts).toBe(1);
  await assertHealthy();
});

test("offers nothing to accept while a card booking waits for the guest's payment", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const state = await openPendingBooking(
    page,
    { method: "card", expectedMethod: "unknown", status: "unpaid" },
    25,
  );

  await expect(page.getByText(WAITING_FOR_CARD)).toBeVisible();
  await expect(page.getByText(CARD_REQUEST)).toHaveCount(0);
  await expect(page.getByText(/manual-payment/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept Booking" })).toHaveCount(0);
  expect(state.accepts).toBe(0);
  await assertHealthy();
});
