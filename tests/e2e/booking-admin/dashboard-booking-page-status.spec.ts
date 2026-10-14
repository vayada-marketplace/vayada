import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  BOOKING_PUBLICATION_PATH,
  bookingPublicationReviewMock,
  fulfillPublication,
  publicationOperationMock,
  type BookingPublicationMockState,
  type BookingReadinessBlockerMock,
} from "../support/bookingPublicationMocks";

const BLOCKERS: BookingReadinessBlockerMock[] = [
  {
    groupId: "booking.calendar",
    step: "calendar",
    message: "Open your calendar and confirm your starting availability.",
  },
  {
    groupId: "booking.guest_experience",
    step: "guest_experience",
    message: "Set your check-in and check-out times and guest policies.",
  },
  { groupId: "booking.payments", step: "payments", message: "Choose how guests can pay." },
];

async function openDashboard(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
}

function statusCard(page: Page): Locator {
  return page.getByRole("region", { name: "Your booking page" });
}

async function capture(card: Locator, testInfo: TestInfo, name: string) {
  await card.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test("a ready hotel publishes its booking page from the dashboard and sees it go online", async ({
  page,
}, testInfo) => {
  await openDashboard(page);
  let state: BookingPublicationMockState = "ready";
  const posts: Array<{ key: string | undefined; body: unknown }> = [];
  const expected = await bookingPublicationReviewMock(BOOKING_ADMIN_PROPERTY_ID, "ready");
  await page.route(BOOKING_PUBLICATION_PATH, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posts.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
      state = "publishing";
      return fulfillPublication(route, {
        status: 202,
        json: publicationOperationMock(BOOKING_ADMIN_PROPERTY_ID),
      });
    }
    const json = await bookingPublicationReviewMock(BOOKING_ADMIN_PROPERTY_ID, state);
    // The next status check finds the publication finished.
    if (request.method() === "GET" && state === "publishing") state = "online";
    return fulfillPublication(route, { json });
  });

  await page.goto("/dashboard");
  const card = statusCard(page);
  await expect(card.getByText("Offline", { exact: true })).toBeVisible();
  await expect(card.getByText("Everything is ready. Publish it so guests can book.")).toBeVisible();
  await expect(card.getByText("All 7 ready")).toBeVisible();
  await capture(card, testInfo, "booking-page-ready");

  await card.getByRole("button", { name: "Publish booking page" }).click();
  await expect(card.getByText("Online", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("link", { name: "hotel-alpenrose.booking.vayada.com" }),
  ).toHaveAttribute("href", "https://hotel-alpenrose.booking.vayada.com");
  await expect(card.getByRole("link", { name: "Open booking page" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(card.getByRole("button")).toHaveCount(0);
  await capture(card, testInfo, "booking-page-online");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.key).toMatch(/^booking-admin:[0-9a-f-]{36}$/);
  expect(posts[0]!.body).toEqual({
    expectedActiveContentRevisionId: null,
    expectedSourceManifestHash: expected.readiness.sourceManifestHash,
    expectedReadinessHash: expected.readiness.readinessHash,
  });
});

test("a hotel that isn't ready sees what's missing and where in setup to fix it", async ({
  page,
}, testInfo) => {
  await openDashboard(page);
  const review = await bookingPublicationReviewMock(
    BOOKING_ADMIN_PROPERTY_ID,
    "not_ready",
    BLOCKERS,
  );
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { json: review }),
  );

  await page.goto("/dashboard");
  const card = statusCard(page);
  await expect(
    card.getByText("Fix 3 things before you can publish. Guests can't book yet."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Publish booking page" })).toBeDisabled();
  for (const blocker of BLOCKERS) await expect(card.getByText(blocker.message)).toBeVisible();

  const links = card.getByRole("link", { name: "Fix in setup" });
  await expect(links).toHaveCount(3);
  const hrefs = await links.evaluateAll((items) =>
    items.map((item) => (item as HTMLAnchorElement).href),
  );
  const urls = hrefs.map((href) => new URL(href));
  expect(urls.map((url) => url.searchParams.get("step"))).toEqual([
    "calendar",
    "guest_experience",
    "payments",
  ]);
  for (const url of urls) {
    expect(url.pathname).toBe("/setup");
    expect(url.searchParams.get("entryProduct")).toBe("booking");
    expect(url.searchParams.get("propertyId")).toBe(BOOKING_ADMIN_PROPERTY_ID);
    expect(url.searchParams.get("returnTo")).toBe("/dashboard");
  }
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await capture(card, testInfo, "booking-page-not-ready");
});

test("a failed publication says nothing changed and lets the hotel try again", async ({
  page,
}, testInfo) => {
  await openDashboard(page);
  let posts = 0;
  await page.route(BOOKING_PUBLICATION_PATH, async (route) => {
    if (route.request().method() === "POST") {
      posts += 1;
      return fulfillPublication(route, { status: 503, json: { code: "unavailable" } });
    }
    return fulfillPublication(route, {
      json: await bookingPublicationReviewMock(BOOKING_ADMIN_PROPERTY_ID, "ready"),
    });
  });

  await page.goto("/dashboard");
  const card = statusCard(page);
  await card.getByRole("button", { name: "Publish booking page" }).click();
  await expect(card.getByText("Publishing failed")).toBeVisible();
  await expect(card.getByText(/Nothing changed for guests/)).toBeVisible();
  await capture(card, testInfo, "booking-page-failed");

  await card.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => posts).toBe(2);
  await expect(card.getByText("Publishing failed")).toBeVisible();
});

test("a publication still running shows progress", async ({ page }, testInfo) => {
  await openDashboard(page);
  const review = await bookingPublicationReviewMock(BOOKING_ADMIN_PROPERTY_ID, "publishing");
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { json: review }),
  );

  await page.goto("/dashboard");
  const card = statusCard(page);
  await expect(card.getByText(/We're putting your booking page online/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  await capture(card, testInfo, "booking-page-publishing");
});

test("owners who can't manage booking settings don't see the card", async ({ page }) => {
  await openDashboard(page);
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { status: 403, json: { code: "forbidden" } }),
  );
  const answered = page.waitForResponse(
    (response) =>
      BOOKING_PUBLICATION_PATH.test(response.url()) && response.request().method() === "GET",
  );

  await page.goto("/dashboard");
  await answered;
  await expect(page.getByRole("heading", { name: "Booking Engine", level: 1 })).toBeVisible();
  await expect(statusCard(page)).toHaveCount(0);
  await expect(page.getByText("We couldn't check your booking page right now.")).toHaveCount(0);
});
