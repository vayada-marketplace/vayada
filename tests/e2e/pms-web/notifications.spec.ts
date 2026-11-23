import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2591: the notifications bell and panel in PMS's top bar, the same as Booking Admin's (VAY-2349). The
// feed is mocked; the panel itself is covered in tests/e2e/booking-admin/notifications.spec.ts.
const FEED_ROUTE = /\/api\/booking\/properties\/[^/]+\/notifications$/;
const DONE_ROUTE = /\/api\/booking\/properties\/[^/]+\/notifications\/done$/;
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

function feed(canOpenPmsBookings = true) {
  return {
    generatedAt: NOW.toISOString(),
    timeZone: "Europe/Berlin",
    syncAlert: null,
    unread: { all: 2, bookings: 1, needsAction: 1, updates: 0 },
    badge: "red",
    canOpenPmsBookings,
    items: [
      {
        key: "booking-event:e0000000-0000-4000-8000-000000000001",
        kind: "booking_new",
        category: "bookings",
        occurredAt: ago(12),
        read: false,
        done: false,
        booking,
      },
      {
        key: "promo-ending:promo_summer20:2026-12-31",
        kind: "promo_ending",
        category: "needs_action",
        occurredAt: ago(60),
        read: false,
        done: false,
        promo: {
          id: "promo_summer20",
          code: "SUMMER20",
          validUntil: "2026-12-31",
          uses: 14,
          maxUses: 100,
        },
      },
    ],
  };
}

async function setUp(page: Page, json: unknown, status = 200) {
  await page.clock.setFixedTime(NOW);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const reads: string[] = [];
  await page.route(FEED_ROUTE, (route) => {
    reads.push(new URL(route.request().url()).pathname);
    return status === 200
      ? route.fulfill({ json })
      : route.fulfill({ status, json: { code: "forbidden" } });
  });
  return reads;
}

const bell = (page: Page) => page.locator("header").getByRole("button", { name: /^Notifications/ });
const panel = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
const rows = (page: Page) => panel(page).getByTestId("notification-row");

test.describe("PMS notifications bell (VAY-2591)", () => {
  test("shows the selected property's notifications in the top bar, as in Booking Admin", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const reads = await setUp(page, feed());
    const done: unknown[] = [];
    await page.route(DONE_ROUTE, (route) => {
      done.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");

    await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
    await expect(page.getByTestId("notifications-badge")).toHaveText("2");
    expect(reads[0]).toBe(`/api/booking/properties/${PMS_WEB_PROPERTY_ID}/notifications`);
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("tab", { name: /^All/ })).toHaveCSS(
      "background-color",
      "rgb(30, 62, 219)",
    );
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText("New booking");
    await expect(rows(page).first().getByTestId("notification-status")).toHaveText("New");
    await page.screenshot({ path: testInfo.outputPath("pms-notifications-1440.png") });

    // The same actions: the promo code is done for the team.
    await panel(page)
      .getByRole("tab", { name: /^Needs action/ })
      .click();
    await rows(page)
      .first()
      .getByRole("button", { name: "Mark as done: Promo code expires soon" })
      .click();
    await expect.poll(() => done).toEqual([{ keys: ["promo-ending:promo_summer20:2026-12-31"] }]);
    await expect(rows(page)).toHaveCount(0);
    await assertHealthy();
  });

  test("View booking opens the booking here in PMS", async ({ page }) => {
    await setUp(page, feed());
    await page.goto("/dashboard");
    await bell(page).click();
    await rows(page).first().getByRole("button", { name: "View booking" }).click();
    await page.waitForURL(`**/bookings/${booking.id}`);
  });

  test("Extend opens the promo code in Booking Admin on the same property", async ({ page }) => {
    await setUp(page, feed());
    const handoffs: unknown[] = [];
    await page.route("**/auth/handoff/create", (route) => {
      handoffs.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, json: { code: "unavailable" } });
    });
    await page.route("http://admin.booking.localhost:3003/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Booking Admin</h1>" }),
    );
    await page.goto("/dashboard");
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Extend" }).click();
    // Without the one-time exchange it asks Booking Admin's sign-in, keeping the page to open.
    await page.waitForURL(/^http:\/\/admin\.booking\.localhost:3003\//);
    expect(decodeURIComponent(page.url())).toContain("/promo-codes?edit=promo_summer20");
    for (const handoff of handoffs)
      expect(handoff).toMatchObject({
        sourceSurface: "pms-web",
        targetSurface: "booking-admin",
        targetPath: "/promo-codes?edit=promo_summer20",
      });
  });

  // A refused read logs the browser's own 403 line, so this one runs without the page-health check.
  test("hides the bell for people the feed refuses", async ({ page }) => {
    const reads = await setUp(page, null, 403);
    await page.goto("/dashboard");
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await expect(page.locator("header")).toBeVisible();
    await expect(bell(page)).toHaveCount(0);
  });
});
