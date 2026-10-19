import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2205: a card deposit was paid when booking; the hotel records the rest it took at the hotel
// (Flamur, 2026-10-19: the existing mark-paid button, "Mark the rest paid ({amount})").
async function cardDepositStay(page: Page, status: string) {
  let paid = false;
  const reservation = () => ({
    ...pmsWebReservation,
    status,
    // The card's payment window closed long ago; it doesn't apply to the rest.
    hostResponseDeadlineAt: "2026-01-01T10:30:00.000Z",
    pricing: {
      totalAmount: { amountDecimal: "240.00", currency: "EUR" },
      balanceAmount: { amountDecimal: paid ? "0.00" : "168.00", currency: "EUR" },
    },
    payment: {
      method: "card",
      expectedMethod: "card",
      status: paid ? "paid" : "partially_paid",
    },
  });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(base, (route) => route.fulfill({ json: { item: reservation() } }));
  await page.route(`${base}/mark-paid`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.commandId).toEqual(expect.any(String));
    paid = true;
    return route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        reservation: reservation(),
      },
    });
  });
  return { paid: () => paid };
}

test("records the rest of a card deposit paid at the hotel", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const stay = await cardDepositStay(page, "confirmed");

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(
    page.getByText(
      "The deposit was paid by card when booking. The rest, €168.00, is paid at the hotel.",
    ),
  ).toBeVisible();
  const markRest = page.getByRole("button", { name: "Mark the rest paid (€168.00)" });
  await markRest.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("rest-due.png") });
  await markRest.click();
  await expect(
    page.getByText(
      "Mark the rest, €168.00, as paid at the hotel? The booking is then paid in full.",
    ),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rest-confirm.png") });
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect.poll(stay.paid).toBe(true);
  await expect(page.getByRole("button", { name: /Mark the rest paid/ })).toHaveCount(0);
  await assertHealthy();
});

test("records the rest once the guest has checked in", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const stay = await cardDepositStay(page, "checked_in");

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await page.getByRole("button", { name: "Mark the rest paid (€168.00)" }).click();
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect.poll(stay.paid).toBe(true);
  await assertHealthy();
});
