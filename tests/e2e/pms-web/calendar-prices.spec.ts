import { expect, test, type Page } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebStayTimes,
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
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guest-stay-times`, (route) =>
      route.fulfill({ json: pmsWebStayTimes({ checkInTime: "14:30", checkOutTime: "11:00" }) }),
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
      "Tue, Nov 3 · from 14:30",
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

// VAY-2470: the phone calendar lists every room of a tapped day with its status and the night's cheapest rate, and
// opens the timeline's popovers as sheets from the bottom of the screen. A second villa, painted 12–13 November.
const ROOM2 = "room_rice_field_villa";

async function addRiceFieldVilla(page: Page) {
  const rooms = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`;
  const room = (roomId: string, roomNumber: string, sortOrder: number) => ({
    roomId,
    roomTypeId: VILLA,
    roomNumber,
    floor: "1",
    status: "available",
    sortOrder,
    metadata: {},
  });
  await page.unroute(rooms);
  await page.route(rooms, (route) =>
    route.fulfill({
      json: {
        ...list([room(ROOM, "Paddy Villa", 0), room(ROOM2, "Rice Field Villa", 1)]),
        orderVersion: "order-1",
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`, (route) =>
    route.fulfill({ json: list([{ ...block, blockId: "block_rice_paint", roomId: ROOM2 }]) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guest-stay-times`, (route) =>
    route.fulfill({ json: pmsWebStayTimes({ checkInTime: "14:30", checkOutTime: "11:00" }) }),
  );
}

test.describe("PMS phone calendar rooms and prices", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-02T08:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await mockPricedVilla(page);
    await addRiceFieldVilla(page);
  });

  const openCalendar = async (page: Page) => {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "November", exact: true })).toBeVisible();
    await expect(page.getByText("Loading bookings and blocks...")).toBeHidden();
  };
  const day = (page: Page, date: string) => page.locator(`[data-day="${date}"]`);
  const roomRow = (page: Page, room: string) =>
    page.getByRole("button", { name: new RegExp(`^#${room}`) });

  test("a tapped day lists every room with its status and price, and opens the popovers as sheets", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await openCalendar(page);
    await day(page, "2026-11-04").click();
    const paddy = roomRow(page, "Paddy Villa");
    const rice = roomRow(page, "Rice Field Villa");
    await expect(paddy).toContainText("Ada Lovelace · Nov 3 → Nov 6");
    await expect(paddy).toContainText("Booked");
    await expect(rice).toContainText("Available");
    await expect(rice).toContainText("€81");
    await expect(rice).toContainText("per night");
    await page.screenshot({ path: testInfo.outputPath("phone-day-rooms.png") });

    // A free room: the timeline's night popover, across the bottom of the screen.
    await rice.click();
    let sheet = page.getByRole("dialog", { name: "#Rice Field Villa · Wed, Nov 4" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Available")).toBeVisible();
    await expect(sheet.getByText("Season: Standard")).toBeVisible();
    await expect(sheet.getByRole("listitem").nth(0)).toHaveText(/Non-refundable\s*Lowest\s*€81/);
    await expect(sheet.getByRole("listitem").nth(1)).toHaveText(/Free cancellation\s*€90/);
    await expect(sheet.getByText("1 night", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Free until Nov 12 · 8 nights open")).toBeVisible();
    await expect(sheet.getByRole("link", { name: /Edit prices & rules/ })).toHaveAttribute(
      "href",
      `/rooms/${VILLA}?tab=prices&date=2026-11-04`,
    );
    const box = await sheet.boundingBox();
    expect(box && [box.x, box.width, Math.round(box.y + box.height)]).toEqual([0, 390, 844]);
    await page.screenshot({ path: testInfo.outputPath("phone-night-sheet.png") });
    // New Booking starts with that room and night.
    await sheet.getByRole("button", { name: "New Booking" }).click();
    await expect(page.getByLabel("Room 1 room")).toHaveValue(ROOM2);
    await expect(page.getByLabel("Room 1 check-in")).toHaveValue("2026-11-04");
    await expect(page.getByLabel("Room 1 check-out")).toHaveValue("2026-11-05");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Room 1 room")).toHaveCount(0);

    // A booking: the timeline's booking popover; Change room opens the reservation window.
    await paddy.click();
    sheet = page.getByRole("dialog", { name: "Ada Lovelace · #Paddy Villa" });
    await expect(sheet).toContainText("Nov 3 → Nov 6 · 3 nights");
    await expect(sheet).toContainText("Confirmed");
    await expect(sheet.getByRole("definition")).toHaveText([
      "Ada Lovelace",
      "Direct",
      "€243",
      "Tue, Nov 3 · from 14:30",
    ]);
    await expect(sheet.getByRole("link", { name: "Open reservation" })).toHaveAttribute(
      "href",
      "/bookings/guest_booking_ada",
    );
    await page.screenshot({ path: testInfo.outputPath("phone-booking-sheet.png") });
    await sheet.getByRole("button", { name: "Change room" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Move to another room|Assign room/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();

    // A block: its reason in the list, Unblock dates and Edit in the sheet.
    await day(page, "2026-11-12").click();
    await expect(paddy).toContainText("Available");
    await expect(rice).toContainText("Painting");
    await expect(rice).toContainText("Blocked");
    await rice.click();
    sheet = page.getByRole("dialog", { name: "Blocked · #Rice Field Villa" });
    await expect(sheet).toContainText("Nov 12 → Nov 14 · 2 nights");
    await expect(sheet.getByRole("button", { name: "Unblock dates" })).toBeVisible();
    await sheet.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByText("Blocked Room")).toBeVisible();
    await page
      .locator("div.fixed.inset-0")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.getByText("Blocked Room")).toHaveCount(0);

    // The next month opens on its first day, with that month's rooms.
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.getByRole("heading", { name: "December", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tuesday, Dec 1" })).toBeVisible();
    await expect(paddy).toContainText("Available");
    await expect(rice).toContainText("€81");
    await assertHealthy();
  });

  test("a dragged range shows each free room's stay total and opens the stay sheet", async ({
    page,
  }) => {
    await openCalendar(page);
    const center = async (date: string) => {
      const box = await day(page, date).boundingBox();
      if (!box) throw new Error(`${date} is not on screen`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const from = await center("2026-11-06");
    const to = await center("2026-11-08");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("heading", { name: "Nov 6 – Nov 8 · 3 nights" })).toBeVisible();

    // The High season nights at the cheapest rate: 3 × €97.20. Ada leaves on the 6th, so both villas are free.
    const paddy = roomRow(page, "Paddy Villa");
    await expect(paddy).toContainText("€291.60");
    await expect(paddy).toContainText("Total");
    await expect(roomRow(page, "Rice Field Villa")).toContainText("€291.60");
    await paddy.click();
    const sheet = page.getByRole("dialog", { name: "#Paddy Villa · Nov 6 → Nov 9 · 3 nights" });
    const totals = sheet.locator("section", { hasText: "Total" }).getByRole("listitem");
    await expect(totals.nth(0)).toHaveText(/Non-refundable\s*Lowest\s*€291.60/);
    await sheet.getByRole("button", { name: "New Booking · 3 nights" }).click();
    await expect(page.getByLabel("Room 1 room")).toHaveValue(ROOM);
    await expect(page.getByLabel("Room 1 check-in")).toHaveValue("2026-11-06");
    await expect(page.getByLabel("Room 1 check-out")).toHaveValue("2026-11-09");
  });

  test("shows the same prices and availability as the timeline for the same nights", async ({
    page,
  }) => {
    await openCalendar(page);
    const phonePrice = async (date: string, room: string) => {
      await day(page, date).click();
      const row = roomRow(page, room);
      await expect(row).toContainText("Available");
      return (await row.locator(".tabular-nums").innerText()).trim();
    };
    const nov4 = await phonePrice("2026-11-04", "Rice Field Villa");
    await expect(roomRow(page, "Paddy Villa")).toContainText("Booked");
    const nov7 = await phonePrice("2026-11-07", "Paddy Villa");
    expect([nov4, nov7]).toEqual(["€81", "€97.20"]);
    // Nothing after Ada: free through the grid's last day, Sunday 6 December.
    await roomRow(page, "Paddy Villa").click();
    const sheet = page.getByRole("dialog", { name: "#Paddy Villa · Sat, Nov 7" });
    await expect(sheet.getByText("Free through Dec 6")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // The same nights on a laptop: the timeline starts today, 2 November.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('[data-bar="booking"]', { hasText: "Ada Lovelace" })).toBeVisible();
    const openNight = async (room: string, index: number) => {
      const box = await page
        .locator("tr", { hasText: `#${room}` })
        .locator("td[colspan]")
        .boundingBox();
      if (!box) throw new Error(`The ${room} row is not on screen`);
      await page.mouse.click(box.x + ((index + 0.5) * box.width) / 21, box.y + box.height - 8);
    };
    await openNight("Rice Field Villa", 2);
    let popover = page.getByRole("dialog", { name: "#Rice Field Villa · Wed, Nov 4" });
    await expect(popover.getByRole("listitem").nth(0)).toContainText("Lowest");
    await expect(popover.getByRole("listitem").nth(0)).toContainText(nov4);
    await page.keyboard.press("Escape");
    await openNight("Paddy Villa", 5);
    popover = page.getByRole("dialog", { name: "#Paddy Villa · Sat, Nov 7" });
    await expect(popover.getByRole("listitem").nth(0)).toContainText(nov7);
  });

  test("the month grid shows each night's cheapest free room under its date", async ({
    page,
  }, testInfo) => {
    // Rice Field Villa is also closed on 4 November, while Ada has Paddy Villa: no villa is free that night.
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`, (route) =>
      route.fulfill({
        json: list([
          { ...block, blockId: "block_rice_paint", roomId: ROOM2 },
          {
            ...block,
            blockId: "block_rice_repair",
            roomId: ROOM2,
            startsOn: "2026-11-04",
            endsOn: "2026-11-04",
            reason: "Repairs",
          },
        ]),
      }),
    );
    await openCalendar(page);
    const price = (date: string) => day(page, date).locator("[data-price]");
    await expect(price("2026-10-30")).toHaveCount(0); // past nights show no price, as on the timeline
    await expect(price("2026-11-03")).toHaveText("€81"); // Ada has Paddy Villa, Rice Field Villa is free
    await expect(price("2026-11-04")).toHaveCount(0);
    await expect(price("2026-11-07")).toHaveText("€97.20"); // the High season
    await expect(price("2026-11-12")).toHaveText("€81"); // Rice Field Villa is painted, Paddy Villa is free
    await page.screenshot({ path: testInfo.outputPath("phone-month-prices.png") });
  });
});
