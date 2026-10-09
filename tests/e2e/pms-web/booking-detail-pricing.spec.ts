import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2089: rooms priced in the pricing editor keep a legacy base rate of 0, so Booking Detail
// must price and name a stay from what was recorded for it.
const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}`;
const stay = { checkIn: "2026-11-16", checkOut: "2026-11-18", adults: 1, children: 0 };
const euros = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });
const night = (serviceDate: string) => ({
  serviceDate,
  applied: euros("100.00"),
  evidenceQuality: "exact",
});

function manualBooking(assignment: object, status = "confirmed") {
  return {
    ...pmsWebReservation,
    source: "manual",
    status,
    stay,
    pricing: { totalAmount: euros("200.00"), balanceAmount: euros("200.00") },
    assignments: [
      {
        ...pmsWebReservation.assignments[0],
        stay,
        nightly: [night("2026-11-16"), night("2026-11-17")],
        ...assignment,
      },
    ],
  };
}

async function mockBooking(page: Page, item: object, ratePlans: object[] = []) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
  await page.route(`${base}/room-types*`, (route) =>
    route.fulfill({
      json: { items: [{ ...pmsWebRoomType, baseRate: euros("0.00"), ratePlans }] },
    }),
  );
  await page.route(
    (url) => url.pathname.endsWith(`/properties/${PMS_WEB_PROPERTY_ID}/reservations`),
    (route) =>
      route.fulfill({ json: { items: [item], pagination: { total: 1, limit: 500, offset: 0 } } }),
  );
  await page.route(`${base}/reservations/${PMS_WEB_RESERVATION_ID}`, (route) =>
    route.fulfill({ json: { item } }),
  );
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/reservations/${PMS_WEB_RESERVATION_ID}/${suffix}`, (route) =>
      route.fulfill({ json: { items: [] } }),
    );
}

const ratePlanValue = (page: Page) =>
  page.locator("main p", { hasText: /^Rate plan$/ }).locator("xpath=following-sibling::p[1]");

test("prices a custom-rate manual stay from its recorded nights", async ({ page }) => {
  await mockBooking(page, manualBooking({ ratePlanId: null, pricingOfferId: null }));
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  const main = page.locator("main");
  await expect(main.getByText("1 room × 2 nights × €100", { exact: true })).toBeVisible();
  await expect(main.getByText(/line-item math/)).toHaveCount(0);
  await expect(ratePlanValue(page)).toHaveText("Custom rate");
});

test("names the published offer a manual stay was booked on", async ({ page }) => {
  await mockBooking(page, manualBooking({ ratePlanId: null, pricingOfferId: "offer-nr" }), [
    {
      ratePlanId: "offer-nr",
      pricingContractVersion: "pricing.v2",
      code: "offer-nr",
      name: "Non-refundable",
      rateType: "non_refundable",
      mealPlan: "room_only",
      baseRate: euros("100.00"),
      active: true,
    },
  ]);
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(ratePlanValue(page)).toHaveText("Non-refundable");
  await expect(page.locator("main").getByText("1 room × 2 nights × €100")).toBeVisible();
});

test("shows no balance due on a cancelled booking in the reservations list", async ({ page }) => {
  await mockBooking(page, manualBooking({ ratePlanId: null, pricingOfferId: null }, "canceled"));
  await page.goto("/bookings");

  const row = page.locator("main tr", { hasText: "VAY-ADA" });
  await expect(row).toContainText("Cancelled");
  await expect(row).toContainText("—");
  await expect(row).not.toContainText("Due");
});

const flexibleTerms = {
  type: "free_until_days_before_arrival",
  freeCancellationDeadlineDays: 7,
  afterDeadlinePenalty: "full_booking_amount",
  noShowPenalty: "full_booking_amount",
};

test("shows the cancellation terms a manual stay was booked under", async ({ page }) => {
  await mockBooking(
    page,
    manualBooking({
      ratePlanId: null,
      pricingOfferId: "offer-flex",
      bookedCancellation: { kind: "flexible", terms: flexibleTerms },
    }),
    [
      {
        ratePlanId: "offer-flex",
        pricingContractVersion: "pricing.v2",
        code: "offer-flex",
        name: "Flexible",
        rateType: "flexible",
        mealPlan: "room_only",
        baseRate: euros("100.00"),
        active: true,
      },
    ],
  );
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  const main = page.locator("main");
  await expect(main.getByText("Cancellation policy · Flexible", { exact: true })).toBeVisible();
  await expect(main.getByText("Free cancellation", { exact: true })).toBeVisible();
  await expect(main.getByText(/7 days before check-in/)).toBeVisible();
  await expect(main.getByText("Full stay", { exact: true })).toBeVisible();
  await expect(main.getByText("Cancelling here records no cancellation charge.")).toBeVisible();
  await expect(main.getByText("Non-refundable")).toHaveCount(0);
});

test("states that a custom rate has no recorded cancellation terms", async ({ page }) => {
  await mockBooking(page, manualBooking({ ratePlanId: null, pricingOfferId: null }));
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  const main = page.locator("main");
  await expect(main.getByText("Cancellation policy · Custom rate", { exact: true })).toBeVisible();
  await expect(main.getByText("No cancellation terms are recorded for this rate.")).toBeVisible();
  await expect(main.getByText("Cancelling here records no cancellation charge.")).toBeVisible();
  await expect(main.getByText(/Non-refundable|full charge/)).toHaveCount(0);
});

test("lists the refund steps of partial-refund terms instead of a free window", async ({
  page,
}) => {
  const partialRefund = {
    ...flexibleTerms,
    flexibleCancellationType: "partial_refund",
    partialRefundTiers: [
      { minDaysBeforeCheckIn: 30, refundPercent: 50 },
      { minDaysBeforeCheckIn: 7, refundPercent: 20 },
    ],
  };
  await mockBooking(
    page,
    manualBooking({
      ratePlanId: null,
      // An offer no longer in the publication: its booked terms still show.
      pricingOfferId: "offer-retired",
      bookedCancellation: { kind: "flexible", terms: partialRefund },
    }),
  );
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  const main = page.locator("main");
  await expect(main.getByText("50% refund", { exact: true }).first()).toBeVisible();
  await expect(main.getByText(/30 days before check-in/)).toBeVisible();
  await expect(main.getByText("20% refund", { exact: true }).first()).toBeVisible();
  await expect(main.getByText(/Within 7 days of check-in/)).toBeVisible();
  await expect(main.getByText("Free cancellation", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Cancellation policy", { exact: true })).toBeVisible();
});
