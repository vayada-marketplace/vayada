import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminBookingFlow,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2349: Booking Admin's notifications bell, its panel and the links out of it (Paper "VAY-2349
// Notifications bell", approved 2026-10-25). The feed is mocked; the API is covered by its own suites.
const FEED_ROUTE = /\/api\/booking\/properties\/[^/]+\/notifications$/;
const READ_ROUTE = /\/api\/booking\/properties\/[^/]+\/notifications\/read$/;
const READ_ALL_ROUTE = /\/api\/booking\/properties\/[^/]+\/notifications\/read-all$/;
// Today, 12:00 UTC (14:00 in Berlin): "12 min ago" and the day groups stay the same on every run.
const NOW = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const booking = {
  id: "b0000000-0000-4000-8000-000000000001",
  reference: "VAY-ABC123",
  guestName: "Sarah Miller",
  guestEmail: null,
  roomName: "Deluxe Garden Room",
  roomCount: 1,
  checkIn: "2027-02-13",
  checkOut: "2027-02-18",
  adults: 2,
  children: 0,
  totalAmount: "600.00",
  currency: "EUR",
  paymentStatus: "unpaid",
  awaiting: null,
  cancelledBy: null,
  cancelReason: null,
  change: null,
};
const syncAlert = {
  key: "channel-sync:c0000000-0000-4000-8000-000000000001:ari.1",
  read: false,
  domains: ["ari"],
  failedAt: ago(5),
  lastSuccessAt: ago(40),
  canRetry: true,
  canViewDetails: true,
};

function fullFeed() {
  return {
    generatedAt: NOW.toISOString(),
    timeZone: "Europe/Berlin",
    syncAlert,
    unread: { all: 3, bookings: 1, needsAction: 2, updates: 0 },
    badge: "red",
    items: [
      {
        key: "booking-event:e0000000-0000-4000-8000-000000000001",
        kind: "booking_new",
        category: "bookings",
        occurredAt: ago(12),
        read: false,
        booking,
      },
      {
        key: "booking-event:e0000000-0000-4000-8000-000000000002",
        kind: "payment_not_received",
        category: "needs_action",
        occurredAt: ago(48),
        read: false,
        booking: {
          ...booking,
          id: "b0000000-0000-4000-8000-000000000002",
          reference: "VAY-DEF456",
          guestName: "Lukas Brandt",
          guestEmail: "lukas@example.com",
          roomName: "Lake View Suite",
          checkIn: "2027-03-04",
          checkOut: "2027-03-08",
          totalAmount: "480.00",
        },
      },
      {
        key: "booking-event:e0000000-0000-4000-8000-000000000003",
        kind: "booking_modified",
        category: "bookings",
        occurredAt: ago(5 * 60),
        read: true,
        booking: {
          ...booking,
          id: "b0000000-0000-4000-8000-000000000003",
          reference: "VAY-GHI789",
          guestName: "Emma Rossi",
          roomName: "Garden Room",
          checkIn: "2027-02-20",
          checkOut: "2027-02-23",
          totalAmount: "360.00",
          change: { kind: "dates", previousTotal: "240.00", newTotal: "360.00" },
        },
      },
      {
        key: "booking-event:e0000000-0000-4000-8000-000000000004",
        kind: "booking_cancelled",
        category: "bookings",
        occurredAt: ago(20 * 60),
        read: true,
        booking: {
          ...booking,
          guestName: "Jonas Weber",
          roomName: "Garden Room",
          checkIn: "2027-03-02",
          checkOut: "2027-03-04",
          totalAmount: "240.00",
          cancelledBy: "guest",
        },
      },
      {
        key: "promo-ending:promo_summer20:2026-10-31",
        kind: "promo_ending",
        category: "needs_action",
        occurredAt: ago(27 * 60),
        read: true,
        promo: {
          id: "promo_summer20",
          code: "SUMMER20",
          validUntil: "2026-10-31",
          uses: 14,
          maxUses: 100,
        },
      },
      {
        key: "promo-limit:promo_welcome10:50",
        kind: "promo_limit_reached",
        category: "needs_action",
        occurredAt: ago(3 * 24 * 60),
        read: true,
        promo: {
          id: "promo_welcome10",
          code: "WELCOME10",
          validUntil: null,
          uses: 50,
          maxUses: 50,
        },
      },
      {
        key: "team-joined:m0000000-0000-4000-8000-000000000001",
        kind: "team_member_joined",
        category: "updates",
        occurredAt: ago(4 * 24 * 60),
        read: true,
        member: { name: "Anna Keller", role: "front_desk" },
      },
    ],
  };
}

const emptyFeed = {
  generatedAt: NOW.toISOString(),
  timeZone: "Europe/Berlin",
  items: [],
  syncAlert: null,
  unread: { all: 0, bookings: 0, needsAction: 0, updates: 0 },
  badge: "none",
};

async function setUp(page: Page, feeds: unknown[]) {
  await page.clock.setFixedTime(NOW);
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const reads: URL[] = [];
  await page.route(FEED_ROUTE, (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({ json: feeds[Math.min(reads.length - 1, feeds.length - 1)] });
  });
  return reads;
}

const bell = (page: Page) => page.locator("header").getByRole("button", { name: /^Notifications/ });
const panel = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
const rows = (page: Page) => panel(page).getByTestId("notification-row");

test.describe("Booking Admin notifications bell (VAY-2349)", () => {
  test("shows the property's feed with the pinned sync error, tabs and a red badge", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const reads = await setUp(page, [fullFeed()]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");

    await expect(bell(page)).toHaveAccessibleName("Notifications, 3 unread");
    const badge = page.getByTestId("notifications-badge");
    await expect(badge).toHaveText("3");
    await expect(badge).toHaveAttribute("data-tone", "red");
    expect(new URL(reads[0]!).pathname).toBe(
      `/api/booking/properties/${BOOKING_ADMIN_PROPERTY_ID}/notifications`,
    );

    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText("3 new")).toBeVisible();
    await expect(panel(page).getByText("Channel manager sync failed")).toBeVisible();
    await expect(panel(page).getByText("URGENT")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Retry sync" })).toBeVisible();
    await expect(rows(page)).toHaveCount(7);
    await expect(rows(page).first()).toContainText("New booking");
    await expect(rows(page).first()).toContainText("€600");
    await expect(rows(page).first()).toContainText("Sarah Miller · Deluxe Garden Room");
    await expect(rows(page).first()).toContainText("12 min ago");
    await expect(rows(page).first()).toHaveAttribute("data-unread", "true");
    await expect(rows(page).nth(1).getByRole("button", { name: "Contact guest" })).toBeVisible();
    await expect(rows(page).nth(2)).toContainText("now €360");
    for (const group of ["Today", "Yesterday", "Earlier this week"])
      await expect(panel(page).getByRole("heading", { name: group })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("notifications-all-1440.png") });

    const tab = (name: RegExp) => panel(page).getByRole("tab", { name });
    await expect(tab(/^Needs action/)).toContainText("2");
    await tab(/^Needs action/).click();
    await expect(tab(/^Needs action/)).toHaveAttribute("aria-selected", "true");
    await expect(rows(page)).toHaveCount(3);
    await expect(panel(page).getByText("Channel manager sync failed")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Extend" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Raise limit" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("notifications-needs-action-1440.png") });

    await tab(/^Bookings/).click();
    await expect(rows(page)).toHaveCount(3);
    await expect(panel(page).getByText("Channel manager sync failed")).toHaveCount(0);
    await tab(/^Updates/).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("Anna Keller joined as Front desk");

    // Escape closes the panel and returns focus to the bell.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(bell(page)).toBeFocused();
    await assertHealthy();
  });

  test("marks notifications read one by one and all at once", async ({ page }) => {
    await setUp(page, [fullFeed()]);
    const marks: unknown[] = [];
    const readAll: unknown[] = [];
    await page.route(READ_ROUTE, (route) => {
      marks.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.route(READ_ALL_ROUTE, (route) => {
      readAll.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();

    await rows(page).first().getByRole("button", { name: "Mark “New booking” as read" }).click();
    await expect
      .poll(() => marks)
      .toEqual([{ keys: ["booking-event:e0000000-0000-4000-8000-000000000001"] }]);
    await expect(rows(page).first()).not.toHaveAttribute("data-unread", "true");
    await expect(page.getByTestId("notifications-badge")).toHaveText("2");
    // The missed payment and the sync error are still unread: still red.
    await expect(page.getByTestId("notifications-badge")).toHaveAttribute("data-tone", "red");

    await panel(page).getByRole("button", { name: "Mark all read" }).click();
    // What the person saw: the feed's time and its sync card.
    await expect
      .poll(() => readAll)
      .toEqual([{ before: NOW.toISOString(), syncAlertKey: syncAlert.key }]);
    await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
    await expect(panel(page).getByText(/ new$/)).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    await expect(bell(page)).toHaveAccessibleName("Notifications");
  });

  test("View booking opens Reservations filtered to that booking", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await setUp(page, [fullFeed()]);
    await page.route(READ_ROUTE, (route) => route.fulfill({ status: 204 }));
    const searches: (string | null)[] = [];
    await page.route(`**/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/reservations*`, (route) => {
      searches.push(new URL(route.request().url()).searchParams.get("search"));
      return route.fulfill({ json: { bookings: [], total: 0, limit: 20, offset: 0 } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await rows(page).first().getByRole("button", { name: "View booking" }).click();

    await expect(page).toHaveURL(/\/reservations\?search=VAY-ABC123$/);
    await expect(page.getByPlaceholder("Search guest, email, or reference")).toHaveValue(
      "VAY-ABC123",
    );
    await expect.poll(() => searches).toContain("VAY-ABC123");

    // From Reservations itself, a link to another booking filters the open page again.
    await bell(page).click();
    await rows(page).nth(2).getByRole("button", { name: "View booking" }).click();
    await expect(page).toHaveURL(/\/reservations\?search=VAY-GHI789$/);
    await expect(page.getByPlaceholder("Search guest, email, or reference")).toHaveValue(
      "VAY-GHI789",
    );
    await expect.poll(() => searches).toContain("VAY-GHI789");
    await assertHealthy();
  });

  test("Extend opens that promo code in Promos", async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await mockBookingAdminBookingFlow(page);
    await page.route(FEED_ROUTE, (route) => route.fulfill({ json: fullFeed() }));
    await page.route(READ_ROUTE, (route) => route.fulfill({ status: 204 }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Extend" }).click();

    await expect(page.getByRole("heading", { name: "Edit Promo Code" })).toBeVisible();
    await expect(page.locator("#promo-code")).toHaveValue("SUMMER20");
    await expect(page).toHaveURL(/\/promo-codes$/);
  });

  test("Retry sync runs the PMS sync, follows it and turns the card green when it succeeds", async ({
    page,
  }, testInfo) => {
    const reads = await setUp(page, [fullFeed(), { ...fullFeed(), syncAlert: null }]);
    await page.route(READ_ROUTE, (route) => route.fulfill({ status: 204 }));
    const commands: unknown[] = [];
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/channex/commands`,
      (route) => {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, json: { operationId: "op-1", status: "queued" } });
      },
    );
    let checks = 0;
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/channex/operations/op-1`,
      (route) => {
        checks += 1;
        return route.fulfill({
          json: { operationId: "op-1", status: checks === 1 ? "running" : "succeeded" },
        });
      },
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Retry sync" }).click();

    await expect(panel(page).getByRole("button", { name: "Syncing…" })).toBeDisabled();
    await expect
      .poll(() => commands)
      .toEqual([
        {
          commandId: expect.any(String),
          idempotencyKey: expect.any(String),
          operationType: "sync_ari",
        },
      ]);
    // Retrying doesn't mark the card read: a failure that comes back must still count.
    await expect(page.getByTestId("notifications-badge")).toHaveText("3");
    // The operation reports success on its second check (every 5 s); then the feed is read again.
    await expect(panel(page).getByRole("status")).toContainText("Channel manager synced", {
      timeout: 20_000,
    });
    await expect.poll(() => reads.length).toBeGreaterThan(1);
    await expect(panel(page).getByText("Channel manager sync failed")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("notifications-synced-1440.png") });
  });

  test("says so when a retried sync fails, and lets the person try again", async ({ page }) => {
    await setUp(page, [fullFeed()]);
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/channex/commands`,
      (route) => route.fulfill({ status: 202, json: { operationId: "op-2", status: "queued" } }),
    );
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/channex/operations/op-2`,
      (route) => route.fulfill({ json: { operationId: "op-2", status: "failed" } }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Retry sync" }).click();
    await expect(panel(page).getByRole("alert")).toContainText("The sync didn't go through", {
      timeout: 20_000,
    });
    await expect(panel(page).getByRole("button", { name: "Retry sync" })).toBeEnabled();
    await expect(panel(page).getByText("Channel manager sync failed")).toBeVisible();
  });

  test("shows Retry sync and View details only to people PMS lets do them", async ({ page }) => {
    await setUp(page, [{ ...fullFeed(), syncAlert: { ...syncAlert, canRetry: false } }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await expect(panel(page).getByText("Channel manager sync failed")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Retry sync" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "View details" })).toBeVisible();
  });

  test("shows the sync error without buttons to people without PMS access", async ({ page }) => {
    await setUp(page, [
      { ...fullFeed(), syncAlert: { ...syncAlert, canRetry: false, canViewDetails: false } },
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await expect(panel(page).getByText("Channel manager sync failed")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Retry sync" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "View details" })).toHaveCount(0);
  });

  test("shows the empty states and a plain bell", async ({ page }, testInfo) => {
    await setUp(page, [emptyFeed]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await expect(bell(page)).toHaveAccessibleName("Notifications");
    await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
    await bell(page).click();
    await expect(panel(page).getByText("You're all caught up")).toBeVisible();
    await expect(
      panel(page).getByText(/channel sync problems for Alpenrose show up here/),
    ).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("notifications-caught-up-1440.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await bell(page).click();
    await expect(panel(page).getByText("You're all caught up")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("notifications-caught-up-390.png") });
  });

  test("shows Nothing here on an empty tab", async ({ page }) => {
    const feed = fullFeed();
    await setUp(page, [
      { ...feed, items: feed.items.filter((item) => item.category !== "updates") },
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await bell(page).click();
    await panel(page)
      .getByRole("tab", { name: /^Updates/ })
      .click();
    await expect(panel(page).getByText("Nothing here")).toBeVisible();
    await expect(panel(page).getByText("Team changes for Alpenrose show up here.")).toBeVisible();
  });

  test("opens as a full-width sheet on phones and closes with its X", async ({
    page,
  }, testInfo) => {
    await setUp(page, [fullFeed()]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    const box = await panel(page).boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(390);
    // Nothing sticks out sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: testInfo.outputPath("notifications-all-390.png") });
    await panel(page)
      .getByRole("tab", { name: /^Needs action/ })
      .click();
    await page.screenshot({ path: testInfo.outputPath("notifications-needs-action-390.png") });

    await panel(page).getByRole("button", { name: "Close notifications" }).click();
    await expect(panel(page)).toHaveCount(0);
  });

  test("reads again every minute and on page change, but not after a refusal", async ({ page }) => {
    await page.clock.install({ time: NOW });
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let reads = 0;
    await page.route(FEED_ROUTE, (route) => {
      reads += 1;
      return route.fulfill({ json: emptyFeed });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings");
    await expect.poll(() => reads).toBeGreaterThan(0);
    const first = reads;
    await page.clock.runFor(60_000);
    await expect.poll(() => reads).toBeGreaterThan(first);

    await page.unroute(FEED_ROUTE);
    let refused = 0;
    await page.route(FEED_ROUTE, (route) => {
      refused += 1;
      return route.fulfill({ status: 403, json: { code: "forbidden" } });
    });
    await page.clock.runFor(60_000);
    await expect.poll(() => refused).toBe(1);
    await page.clock.runFor(120_000);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Design Studio" })
      .click();
    await expect(page).toHaveURL(/\/design-studio$/);
    expect(refused).toBe(1);
    // No access: no bell at all, rather than a panel that never loads.
    await expect(bell(page)).toHaveCount(0);
  });
});
