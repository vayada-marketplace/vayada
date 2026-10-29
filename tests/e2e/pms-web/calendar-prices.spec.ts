import { expect, test, type Page } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebReservation,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2411: the timeline shows each free night's cheapest rate from the published prices, behind a "Show prices"
// switch in the ☰ menu that each user's browser remembers.
const VILLA = "dddddddd-0000-4000-8000-00000000000d";
const ROOM = "room_paddy_villa";
const TERMS = "66666666-6666-4666-8666-666666666666";
const token = (digit: string) => digit.repeat(64);
const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat", amountMinor });
const offer = (
  id: string,
  price: Record<string, unknown>,
  restrictions: Record<string, unknown>,
) => ({
  id,
  termsRevision: TERMS,
  meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
  price,
  restrictions,
});
// Free cancellation €90, "High" season €108 from 6 to 8 November, an own price of €70 on 30 October; Non-refundable
// is 10% less, so it is the cheapest rate every night.
const publication = {
  currency: "EUR",
  revision: 3,
  stale: false,
  sources: {
    room: `pms.pricing.rooms.v2:${token("3")}`,
    terms: `booking.pricing.terms.v2:${token("4")}`,
    finance: `finance.pricing.source.v2:${token("5")}`,
  },
  ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
  rooms: [
    {
      version: "pricing.v2",
      propertyId: PMS_WEB_PROPERTY_ID,
      roomTypeId: VILLA,
      revision: 3,
      currency: "EUR",
      capacity: { total: 3, adults: 2, children: 1 },
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
      },
      offers: [
        offer(
          "flex",
          {
            kind: "independent",
            calendar: {
              base: flat("9000"),
              months: [],
              seasons: [
                { name: "High", tier: "", from: "11-06", through: "11-08", price: flat("10800") },
              ],
              weekdays: [],
              dates: [{ date: "2026-10-30", price: flat("7000") }],
            },
          },
          { kind: "own", rules, seasons: [], dates: [] },
        ),
        offer(
          "nonref",
          {
            kind: "linked",
            parentId: "flex",
            adjustment: { kind: "percentage", basisPoints: -1000 },
            dateOverrides: [],
          },
          { kind: "inherit" },
        ),
      ],
    },
  ],
};
const ratePlan = (ratePlanId: string, rateType: "flexible" | "non_refundable") => ({
  ratePlanId,
  pricingContractVersion: "pricing.v2",
  name: rateType === "flexible" ? "Flexible" : "Non-refundable",
  rateType,
  mealPlan: "room_only",
  baseRate: { amountDecimal: "90.00", currency: "EUR" },
  cancellationPolicySnapshot:
    rateType === "flexible"
      ? {
          kind: "flexible",
          terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: 7 },
        }
      : { kind: "non_refundable" },
  active: true,
});
const list = (items: unknown[]) => ({
  contractVersion: "pms-operations.v1",
  propertyId: PMS_WEB_PROPERTY_ID,
  items,
  sourceFreshness: {},
});

async function mockPricedVilla(page: Page) {
  const routes = {
    roomTypes: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`,
    rooms: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`,
    reservations: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`,
  };
  for (const route of Object.values(routes)) await page.unroute(route);
  await page.route(routes.roomTypes, (route) =>
    route.fulfill({
      json: list([
        {
          ...pmsWebRoomType,
          roomTypeId: VILLA,
          name: "Paddy Villa",
          ratePlans: [ratePlan("flex", "flexible"), ratePlan("nonref", "non_refundable")],
        },
      ]),
    }),
  );
  await page.route(routes.rooms, (route) =>
    route.fulfill({
      json: {
        ...list([
          {
            roomId: ROOM,
            roomTypeId: VILLA,
            roomNumber: "Paddy Villa",
            floor: "1",
            status: "available",
            sortOrder: 0,
            metadata: {},
          },
        ]),
        orderVersion: "order-1",
      },
    }),
  );
  // Ada stays 3–6 November: those three nights are taken, her check-out day is free again.
  const ada = {
    ...pmsWebReservation,
    stay: { ...pmsWebReservation.stay, checkIn: "2026-11-03", checkOut: "2026-11-06" },
    assignments: [
      {
        ...pmsWebReservation.assignments[0],
        roomTypeId: VILLA,
        roomId: ROOM,
        roomNumber: "Paddy Villa",
      },
    ],
  };
  await page.route(routes.reservations, (route) =>
    route.fulfill({
      json: { ...list([ada]), pagination: { total: 1, limit: 500, offset: 0 } },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ json: publication }),
  );
}

test.describe("PMS calendar prices", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-28T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await mockPricedVilla(page);
  });

  test("shows each free night's cheapest rate and remembers the Show prices switch", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.goto("/calendar");
    // The timeline shows 28 October – 17 November: 21 nights, three of them Ada's.
    const villa = page.locator("tr", { hasText: "#Paddy Villa" });
    const price = (text: string) => villa.getByText(text, { exact: true });
    await expect(price("€63")).toHaveCount(1); // 30 October's own price, less 10%
    await expect(price("€97.20")).toHaveCount(3); // the High season, 6–8 November: Ada leaves on the 6th
    await expect(price("€81")).toHaveCount(14);
    await page.screenshot({ path: testInfo.outputPath("calendar-prices.png") });

    const menu = page.getByRole("button", { name: "Room view options" });
    const showPrices = page.getByRole("switch", { name: "Show prices" });
    await menu.click();
    await expect(showPrices).toHaveAttribute("aria-checked", "true");
    await showPrices.click();
    await expect(showPrices).toHaveAttribute("aria-checked", "false");
    await expect(price("€81")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("tr", { hasText: "#Paddy Villa" })).toBeVisible();
    await expect(price("€81")).toHaveCount(0);
    await menu.click();
    await expect(showPrices).toHaveAttribute("aria-checked", "false");
    await showPrices.click();
    await expect(price("€81")).toHaveCount(14);
    await assertHealthy();
  });
});
