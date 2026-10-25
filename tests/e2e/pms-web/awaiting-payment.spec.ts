import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2348: a booking-page bank transfer waiting for the guest's money. Its room is held before any
// room is assigned, so the calendar draws it (striped, unassigned) instead of showing the room free.
const awaiting = {
  ...pmsWebReservation,
  status: "pending_payment",
  assignments: [],
  roomCount: 1,
  pricing: {
    totalAmount: { amountDecimal: "360.00", currency: "EUR" },
    balanceAmount: { amountDecimal: "360.00", currency: "EUR" },
  },
  payment: { method: "bank_transfer", expectedMethod: "bank_transfer", status: "unpaid" },
  // 15:30 in Vienna (the mocked hotel's time zone) on Thursday 13 August.
  hostResponseDeadlineAt: "2026-08-13T13:30:00.000Z",
  awaitingHotelPaymentConfirmation: true,
};

async function mockAwaitingBooking(page: Page) {
  await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const list = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
  await page.unroute(list);
  await page.route(list, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [awaiting],
        sourceFreshness: {},
        pagination: { total: 1, limit: 500, offset: 0 },
      },
    }),
  );
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  await page.route(base, (route) => route.fulfill({ json: { item: awaiting } }));
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
}

test.describe("PMS awaiting payment (VAY-2348)", () => {
  test.beforeEach(async ({ page }) => mockAwaitingBooking(page));

  test("lists the booking as awaiting payment with its deadline in hotel time", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.goto("/bookings");
    const row = page.locator("tr", { hasText: "Ada Lovelace" });
    await expect(row.getByText("Awaiting payment")).toBeVisible();
    await expect(row.getByText(/^Pay by .*13.*15:30$/)).toBeVisible();
    await assertHealthy();
  });

  test("draws the held room on the calendar and confirms the transfer from its card", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.goto("/calendar");
    const bar = page.locator('[data-bar="booking"]', { hasText: "awaiting payment" });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Ada Lovelace");
    expect(await bar.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
      "repeating-linear-gradient",
    );
    await expect(bar).toHaveAttribute("title", /Pay by .*13.*15:30/);

    await bar.click();
    const card = page.getByRole("dialog", { name: "Ada Lovelace" });
    await expect(card.getByText(/^Pay by .*13.*15:30$/)).toBeVisible();
    await expect(card.getByRole("link", { name: "Open booking" })).toHaveAttribute(
      "href",
      `/bookings/${PMS_WEB_RESERVATION_ID}`,
    );
    await card.getByRole("link", { name: "Mark transfer received" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}\\?confirm=payment$`),
    );
    await expect(page.getByText("Waiting for the bank transfer")).toBeVisible();
    await expect(
      page.getByText(
        "Mark the transfer of €360.00 from Ada Lovelace (reference VAY-ADA) as received?",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark received" })).toBeVisible();
    await assertHealthy();
  });
});
