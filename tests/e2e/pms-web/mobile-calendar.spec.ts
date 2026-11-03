import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
  pmsWebReservation,
} from "../support/pmsWebMocks";

const futureReservation = {
  ...pmsWebReservation,
  guestBookingId: `${PMS_WEB_RESERVATION_ID}_future`,
  bookingReference: "VAY-FUTURE",
  stay: { ...pmsWebReservation.stay, checkIn: "2027-02-14", checkOut: "2027-02-16" },
  primaryGuest: {
    ...pmsWebReservation.primaryGuest,
    displayName: "Future Guest",
    email: "future@example.com",
  },
};

const futureBlock = {
  blockId: "room_block_future",
  version: "room-block-v1",
  roomTypeId: PMS_WEB_ROOM_TYPE_ID,
  roomId: PMS_WEB_ROOM_ID,
  startsOn: "2027-02-20",
  endsOn: "2027-02-20",
  blockedCount: 1,
  reason: "Owner maintenance",
  status: "active",
};

// VAY-2470: Timo's booking — a long booking reference and email made the reservation sheet scroll sideways.
const longReferenceReservation = {
  ...pmsWebReservation,
  bookingReference: "C01D5073548DEA79A67855EF0453F",
  primaryGuest: {
    ...pmsWebReservation.primaryGuest,
    displayName: "Timo Schreyer",
    email: "timo.schreyer.reservations@vayada-hotels.example.com",
    phone: "+4915735490950",
  },
};

/** The open window: the last full-screen overlay's panel. */
const openSheet = (page: Page) => page.locator("div.fixed.inset-0 > div.relative").last();

/** Nothing in the sheet reaches past its edges, the sheet stays on screen, and nothing scrolls sideways. */
async function expectSheetFits(sheet: Locator) {
  const fit = await sheet.evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    const sticksOut: string[] = [];
    const scrollsSideways: string[] = [];
    for (const el of Array.from(panel.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) {
        sticksOut.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`,
        );
      }
      const overflowX = getComputedStyle(el).overflowX;
      const scroller =
        overflowX === "auto" || overflowX === "scroll" || el.matches(".overflow-y-auto");
      if (scroller && el.scrollWidth > el.clientWidth + 1) {
        scrollsSideways.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    return {
      left: Math.round(box.left),
      right: Math.round(box.right),
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      sticksOut,
      scrollsSideways,
    };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.viewport);
  expect(fit.pageWidth).toBeLessThanOrEqual(fit.viewport);
  expect(fit.sticksOut).toEqual([]);
  expect(fit.scrollsSideways).toEqual([]);
}

test.describe("mobile PMS calendar", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fetches the visible range and renders bookings and blocks six months ahead", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    const reservationRanges: Array<{ from: string | null; to: string | null }> = [];
    const blockRanges: Array<{ from: string | null; to: string | null }> = [];
    let releaseNextMonthRequests!: () => void;
    const nextMonthRequests = new Promise<void>((resolve) => {
      releaseNextMonthRequests = resolve;
    });
    let releaseStaleRequests!: () => void;
    const staleRequests = new Promise<void>((resolve) => {
      releaseStaleRequests = resolve;
    });
    let releaseFutureRequests!: () => void;
    const futureRequests = new Promise<void>((resolve) => {
      releaseFutureRequests = resolve;
    });

    const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
    await page.unroute(reservationsRoute);
    await page.route(reservationsRoute, async (route) => {
      const url = new URL(route.request().url());
      const range = {
        from: url.searchParams.get("stayFrom"),
        to: url.searchParams.get("stayTo"),
      };
      reservationRanges.push(range);
      const isNextMonthRange = range.from === "2026-08-31" && range.to === "2026-10-05";
      const isStaleRange = range.from === "2026-12-28" && range.to === "2027-02-01";
      const isFutureRange = range.from === "2027-02-01" && range.to === "2027-03-01";
      if (isNextMonthRange) await nextMonthRequests;
      if (isStaleRange) await staleRequests;
      if (isFutureRange) await futureRequests;
      const items = isFutureRange ? [futureReservation] : [pmsWebReservation];
      await route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items,
          sourceFreshness: {},
          pagination: { total: items.length, limit: 500, offset: 0 },
        },
      });
    });

    const blocksRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`;
    await page.unroute(blocksRoute);
    await page.route(blocksRoute, async (route) => {
      const url = new URL(route.request().url());
      const range = {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      };
      blockRanges.push(range);
      const isNextMonthRange = range.from === "2026-08-31" && range.to === "2026-10-05";
      const isStaleRange = range.from === "2026-12-28" && range.to === "2027-02-01";
      const isFutureRange = range.from === "2027-02-01" && range.to === "2027-03-01";
      if (isNextMonthRange) await nextMonthRequests;
      if (isStaleRange) await staleRequests;
      if (isFutureRange) await futureRequests;
      await route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: isFutureRange ? [futureBlock] : [],
          sourceFreshness: {},
        },
      });
    });

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "August", exact: true })).toBeVisible();
    await expect(page.getByText("Loading bookings and blocks...")).toBeHidden();

    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.getByRole("heading", { name: "September", exact: true })).toBeVisible();
    await expect(page.getByText("Loading bookings and blocks...")).toBeVisible();
    await expect(page.getByText("No bookings or blocks on this day")).toBeHidden();
    releaseNextMonthRequests();
    await expect(page.getByText("Loading bookings and blocks...")).toBeHidden();

    for (let month = 0; month < 5; month += 1) {
      await page.getByRole("button", { name: "Next month" }).click();
    }

    await expect(page.getByRole("heading", { name: "February", exact: true })).toBeVisible();
    await expect
      .poll(() => reservationRanges.at(-1))
      .toEqual({
        from: "2027-02-01",
        to: "2027-03-01",
      });
    await expect
      .poll(() => blockRanges.at(-1))
      .toEqual({
        from: "2027-02-01",
        to: "2027-03-01",
      });
    await expect(page.getByText("Loading bookings and blocks...")).toBeVisible();
    await expect(page.getByText("No bookings or blocks on this day")).toBeHidden();

    releaseFutureRequests();

    const bookedDay = page.locator('[data-day="2027-02-14"]');
    await bookedDay.click();
    await expect(page.getByText("Future Guest")).toBeVisible();
    await expect(
      bookedDay.locator('[class~="w-1"][class~="h-1"][class~="rounded-full"]'),
    ).toHaveCount(1);

    releaseStaleRequests();
    await page.waitForTimeout(250);
    await expect(page.getByRole("heading", { name: "February", exact: true })).toBeVisible();
    await expect(page.getByText("Future Guest")).toBeVisible();

    const blockedDay = page.locator('[data-day="2027-02-20"]');
    await blockedDay.click();
    await expect(page.getByText("Owner maintenance")).toBeVisible();
    await expect(
      blockedDay.locator('[class~="w-1"][class~="h-1"][class~="rounded-full"]'),
    ).toHaveCount(1);

    const settledReservationRequestCount = reservationRanges.length;
    const settledBlockRequestCount = blockRanges.length;
    await page.waitForTimeout(250);
    expect(reservationRanges).toHaveLength(settledReservationRequestCount);
    expect(blockRanges).toHaveLength(settledBlockRequestCount);
  });

  test("the reservation, New Booking and Block windows fit a phone screen", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
    await page.unroute(reservationsRoute);
    await page.route(reservationsRoute, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [longReferenceReservation],
          sourceFreshness: {},
          pagination: { total: 1, limit: 500, offset: 0 },
        },
      }),
    );
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
      (route) =>
        route.fulfill({
          json: {
            contractVersion: "pms-operations.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            item: longReferenceReservation,
            sourceFreshness: {},
          },
        }),
    );

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "August", exact: true })).toBeVisible();
    await expect(page.getByText("Loading bookings and blocks...")).toBeHidden();

    // The booking's sheet (VAY-2470) opens the reservation window with Change room.
    await page.locator('[data-day="2026-08-15"]').click();
    await page.getByRole("button", { name: /Timo Schreyer/ }).click();
    await page.getByRole("button", { name: "Change room" }).click();
    const sheet = openSheet(page);
    await expect(sheet.getByText("C01D5073548DEA79A67855EF0453F")).toBeVisible();
    await expect(sheet.getByText("Confirmed", { exact: true })).toBeInViewport({ ratio: 1 });
    await expectSheetFits(sheet);
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await expect(sheet.getByText("C01D5073548DEA79A67855EF0453F")).toBeHidden();

    await page.locator('[data-day="2026-08-20"]').click();
    await page.getByRole("button", { name: "+ New", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New Booking" })).toBeVisible();
    await expectSheetFits(openSheet(page));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "New Booking" })).toBeHidden();

    await page.getByRole("button", { name: "Block", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Block Rooms" })).toBeVisible();
    await expectSheetFits(openSheet(page));
  });
});
