import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2360 part 3: extras a guest asked for after booking wait on the booking page, where the hotel
// accepts them (charged at check-in, the total stays) or declines them with a reason for the guest.
const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
const item = (name: string, pricingModel: string, unitMinor: string, amountMinor: string) => ({
  addonId: name.toLowerCase().replace(/ /g, "-"),
  name,
  pricingModel,
  unitMinor,
  amountMinor,
  currency: "EUR",
  guests: 2,
  nights: 3,
});
const pending = {
  id: "11111111-2222-4333-8444-555555555555",
  status: "pending",
  items: [
    item("Airport transfer", "per_stay", "2500", "2500"),
    item("Breakfast", "per_guest_night", "1800", "10800"),
  ],
  totalMinor: "13300",
  currency: "EUR",
  createdAt: "2026-10-20T09:00:00.000Z",
  decidedAt: null,
  note: null,
};
// An earlier request the hotel accepted: still to charge at check-in, so it stays on the page.
const earlier = {
  ...pending,
  id: "11111111-2222-4333-8444-000000000001",
  status: "accepted",
  items: [item("Late check-out", "per_stay", "1000", "1000")],
  totalMinor: "1000",
  createdAt: "2026-10-18T09:00:00.000Z",
  decidedAt: "2026-10-19T09:00:00.000Z",
};

async function mockExtras(page: Page, status = "confirmed") {
  const decisions: { decision: string; key: string | undefined; body: unknown }[] = [];
  let current: Record<string, unknown> = pending;
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(base, (route) =>
    route.fulfill({ json: { item: { ...pmsWebReservation, status } } }),
  );
  await page.route(`${base}/extras-request`, (route) =>
    route.fulfill({ json: { version: "booking-extras-requests.v1", items: [current, earlier] } }),
  );
  await page.route(`${base}/extras-request/${pending.id}/*`, (route) => {
    const decision = new URL(route.request().url()).pathname.split("/").pop()!;
    decisions.push({
      decision,
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    current = {
      ...pending,
      status: decision === "accept" ? "accepted" : "declined",
      decidedAt: "2026-10-21T09:00:00.000Z",
    };
    return route.fulfill({ json: current });
  });
  return decisions;
}

test("accepts the extras a guest asked for, to charge at check-in", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const decisions = await mockExtras(page);

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const cards = page.getByTestId("extras-request-card");
  await expect(cards).toHaveCount(2);
  const card = cards.first();
  await expect(card.getByText("Extras requested by the guest")).toBeVisible();
  await expect(card.getByText(/^Ada Lovelace asked for these on the booking page/)).toBeVisible();
  await expect(card.getByText("€18.00 per guest per night · 2 guests · 3 nights")).toBeVisible();
  await expect(card.getByText("€108.00")).toBeVisible();
  await expect(card.getByText("To charge at check-in")).toBeVisible();
  await expect(card.getByText("€133.00")).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath("extras-pending-1440.png") });

  await card.getByRole("button", { name: "Accept extras" }).click();
  await expect(card.getByText(/^Extras accepted on (21 Oct|Oct 21)$/)).toBeVisible();
  await expect(card.getByText("Ada Lovelace got an email. Charge them at check-in.")).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  // The earlier accepted extras are still there to charge.
  await expect(cards.nth(1).getByText(/^Extras accepted on (19 Oct|Oct 19)$/)).toBeVisible();
  await expect(cards.nth(1).getByText("Late check-out")).toBeVisible();
  await cards
    .first()
    .locator("xpath=..")
    .screenshot({ path: testInfo.outputPath("extras-accepted-1440.png") });
  expect(decisions).toEqual([
    {
      decision: "accept",
      key: `booking.extras:accept:${PMS_WEB_RESERVATION_ID}:${pending.id}`,
      body: {},
    },
  ]);
  await assertHealthy();
});

// On a phone, where the card spans the screen.
test("declines the extras with a reason for the guest", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const assertHealthy = watchPageHealth(page, testInfo);
  const decisions = await mockExtras(page);

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const card = page.getByTestId("extras-request-card").first();
  await card.getByRole("button", { name: "Decline", exact: true }).click();
  await card.getByLabel("Reason for the guest (optional)").fill("Our shuttle is fully booked.");
  await card.screenshot({ path: testInfo.outputPath("extras-declining-390.png") });
  await card.getByRole("button", { name: "Decline extras" }).click();
  await expect(
    page.getByText(
      /^Extras declined on (21 Oct|Oct 21): Airport transfer, Breakfast\. Ada Lovelace got an email\.$/,
    ),
  ).toBeVisible();
  // Only the earlier accepted request is still a card.
  await expect(page.getByTestId("extras-request-card")).toHaveCount(1);
  expect(decisions).toEqual([
    {
      decision: "decline",
      key: `booking.extras:decline:${PMS_WEB_RESERVATION_ID}:${pending.id}`,
      body: { reason: "Our shuttle is fully booked." },
    },
  ]);
  await assertHealthy();
});

// A cancelled booking page reads more than these mocks answer, so this one checks the cards only.
test("a cancelled stay's waiting request can't be answered", async ({ page }) => {
  const decisions = await mockExtras(page, "canceled");

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  const cards = page.getByTestId("extras-request-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.getByText("Late check-out")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept extras" })).toHaveCount(0);
  expect(decisions).toEqual([]);
});
