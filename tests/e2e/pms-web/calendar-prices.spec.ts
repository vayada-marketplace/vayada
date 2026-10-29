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

// Ada's booking total and the hotel's check-in time from its arrival times (VAY-2411 booking popover).
const adaPricing = {
  amountStatus: "recorded",
  totalAmount: { amountDecimal: "243.00", currency: "EUR" },
  balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
};
const block = {
  blockId: "block_paint",
  version: "room-block-v1",
  roomTypeId: VILLA,
  roomId: ROOM,
  startsOn: "2026-11-12",
  endsOn: "2026-11-13",
  blockedCount: 1,
  reason: "Painting",
  status: "active",
  kind: "manual",
};

async function mockPricedVilla(page: Page) {
  const routes = {
    roomTypes: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`,
    rooms: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`,
    reservations: `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`,
  };
  await page.unroute(routes.roomTypes);
  await page.unroute(routes.rooms);
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
    pricing: adaPricing,
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
  // Ada's own read, for the booking window "Change room" opens.
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${pmsWebReservation.guestBookingId}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: ada,
          sourceFreshness: {},
        },
      }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ json: publication }),
  );
}

/** The bottom of night `index` (0 is 28 October) in the villa's row, below any booking bar. */
async function night(page: Page, index: number) {
  const box = await page
    .locator("tr", { hasText: "#Paddy Villa" })
    .locator("td[colspan]")
    .boundingBox();
  if (!box) throw new Error("The villa's row is not on screen");
  return { x: box.x + ((index + 0.5) * box.width) / 21, y: box.y + box.height - 8 };
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

  test("opens a night's popover on a click and a stay's popover only on a drag to the right", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.goto("/calendar");
    await expect(page.locator("tr", { hasText: "#Paddy Villa" }).getByText("€63")).toBeVisible();

    // One night: its rates cheapest first, the season, the stay rules and the room's next booking.
    let point = await night(page, 2);
    await page.mouse.click(point.x, point.y);
    let popover = page.getByRole("dialog", { name: "#Paddy Villa · Fri, Oct 30" });
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Available")).toBeVisible();
    await expect(popover.getByText("Season: Standard")).toBeVisible();
    await expect(popover.getByRole("listitem").nth(0)).toHaveText(/Non-refundable\s*Lowest\s*€63/);
    await expect(popover.getByRole("listitem").nth(1)).toHaveText(/Free cancellation\s*€70/);
    await expect(popover.getByText("1 night", { exact: true })).toBeVisible();
    await expect(popover.getByText("Free until Nov 3 · 4 nights open")).toBeVisible();
    await expect(popover.getByText("Next arrival Nov 3: Ada Lovelace · Direct")).toBeVisible();
    await expect(popover.getByText(/hard to sell/)).toHaveCount(0);
    await expect(popover.getByRole("link", { name: /Edit prices & rules/ })).toHaveAttribute(
      "href",
      `/rooms/${VILLA}?tab=prices&date=2026-10-30`,
    );
    await page.screenshot({ path: testInfo.outputPath("calendar-night-popover.png") });

    // A second click opens that night alone, not a stay; 1 November leaves one night before Ada.
    point = await night(page, 4);
    await page.mouse.click(point.x, point.y);
    popover = page.getByRole("dialog", { name: "#Paddy Villa · Sun, Nov 1" });
    await expect(popover).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(popover.getByText(/Leaves 1 night open before the next booking/)).toBeVisible();

    // A drag to the right stops before Ada's stay and totals each rate.
    const from = await night(page, 2);
    const to = await night(page, 11);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    popover = page.getByRole("dialog", { name: "#Paddy Villa · Oct 30 → Nov 3 · 4 nights" });
    await expect(popover).toBeVisible();
    const total = popover.locator("section", { hasText: "Total" }).getByRole("listitem");
    await expect(total.nth(0)).toHaveText(/Non-refundable\s*Lowest\s*€306/);
    await expect(total.nth(1)).toHaveText(/Free cancellation\s*€340/);
    await expect(popover.getByRole("button", { name: "New Booking · 4 nights" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("calendar-stay-popover.png") });

    // No dragging to the left: the night where the drag started opens alone.
    const right = await night(page, 5);
    const left = await night(page, 1);
    await page.mouse.move(right.x, right.y);
    await page.mouse.down();
    await page.mouse.move(left.x, left.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("dialog", { name: "#Paddy Villa · Mon, Nov 2" })).toBeVisible();

    // Escape closes it, and a booked night opens nothing.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    point = await night(page, 7);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await assertHealthy();
  });

  test("opens a booking's and a block's popover from their bars", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`, (route) =>
      route.fulfill({ json: list([block]) }),
    );
    await page.route(
      `**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/booking-guest-policy`,
      (route) =>
        route.fulfill({ json: { current: { bundle: { choices: { checkInTime: "15:00" } } } } }),
    );
    await page.goto("/calendar");

    await page.locator('[data-bar="booking"]', { hasText: "Ada Lovelace" }).click();
    const booking = page.getByRole("dialog", { name: "Ada Lovelace · #Paddy Villa" });
    await expect(booking).toContainText("Nov 3 → Nov 6 · 3 nights");
    await expect(booking).toContainText("Confirmed");
    await expect(booking.getByRole("definition")).toHaveText([
      "Ada Lovelace",
      "Direct",
      "€243",
      "Tue, Nov 3 · from 15:00",
    ]);
    await expect(booking.getByRole("link", { name: "Open reservation" })).toHaveAttribute(
      "href",
      "/bookings/guest_booking_ada",
    );
    await page.screenshot({ path: testInfo.outputPath("calendar-booking-popover.png") });
    // Change room opens the calendar's booking window with its room tools.
    await booking.getByRole("button", { name: "Change room" }).click();
    await expect(booking).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Move to another room|Assign room/ }),
    ).toBeVisible();

    await page.goto("/calendar");
    await page.locator('[data-bar="block"]', { hasText: "Painting" }).click();
    const blocked = page.getByRole("dialog", { name: "Blocked · #Paddy Villa" });
    await expect(blocked).toContainText("Nov 12 → Nov 14 · 2 nights");
    await expect(blocked).toContainText("Painting");
    await expect(blocked.getByRole("button", { name: "Unblock dates" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("calendar-block-popover.png") });
    await blocked.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByText("Blocked Room")).toBeVisible();
    await assertHealthy();
  });
});
