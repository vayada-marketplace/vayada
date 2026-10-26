import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
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

async function mockExtras(page: Page) {
  const decisions: { decision: string; key: string | undefined; body: unknown }[] = [];
  let current: Record<string, unknown> = pending;
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(`${base}/extras-request`, (route) => route.fulfill({ json: current }));
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
  const card = page.getByTestId("extras-request-card");
  await expect(card.getByText("Extras requested by the guest")).toBeVisible();
  await expect(card.getByText(/^Ada Lovelace asked for these on the booking page/)).toBeVisible();
  await expect(card.getByText("€18.00 per guest per night · 2 guests · 3 nights")).toBeVisible();
  await expect(card.getByText("€108.00")).toBeVisible();
  await expect(card.getByText("To charge at check-in")).toBeVisible();
  await expect(card.getByText("€133.00")).toBeVisible();

  await card.getByRole("button", { name: "Accept extras" }).click();
  await expect(card.getByText(/^Extras accepted on (21 Oct|Oct 21)$/)).toBeVisible();
  await expect(card.getByText("Ada Lovelace got an email. Charge them at check-in.")).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(decisions).toEqual([
    {
      decision: "accept",
      key: `booking.extras:accept:${PMS_WEB_RESERVATION_ID}:${pending.id}`,
      body: {},
    },
  ]);
  await assertHealthy();
});

test("declines the extras with a reason for the guest", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const decisions = await mockExtras(page);

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const card = page.getByTestId("extras-request-card");
  await card.getByRole("button", { name: "Decline", exact: true }).click();
  await card.getByLabel("Reason for the guest (optional)").fill("Our shuttle is fully booked.");
  await card.getByRole("button", { name: "Decline extras" }).click();
  await expect(
    page.getByText(
      /^Extras declined on (21 Oct|Oct 21): Airport transfer, Breakfast\. Ada Lovelace got an email\.$/,
    ),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(decisions).toEqual([
    {
      decision: "decline",
      key: `booking.extras:decline:${PMS_WEB_RESERVATION_ID}:${pending.id}`,
      body: { reason: "Our shuttle is fully booked." },
    },
  ]);
  await assertHealthy();
});
