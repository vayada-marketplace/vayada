import { expect, test, type Page } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebChannelManagerView,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2606: the Channel manager, view only (Paper "VAY-2606 Channel manager v1", approved 2026-11-26).
const viewUrl = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channel-manager`;
const acknowledgeUrl = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex/alerts/*/acknowledge`;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const connected = {
  ...pmsWebChannelManagerView,
  connection: { status: "connected" },
  channels: {
    status: "ok",
    items: [
      {
        ota: "booking_com",
        active: true,
        otaPropertyId: "4417201",
        mappedCount: 3,
        markup: {
          kind: "rules",
          rules: [{ operation: "increase_by_percent", value: "12" }],
          currency: "EUR",
        },
      },
      {
        ota: "airbnb",
        active: true,
        otaPropertyId: null,
        mappedCount: 3,
        markup: {
          kind: "rules",
          rules: [{ operation: "increase_by_percent", value: "10" }],
          currency: "EUR",
        },
      },
    ],
  },
  rooms: [
    ["t1", "Alpine Suite", 2, true, null],
    ["t2", "Garden Room", 2, true, null],
    ["t3", "Lake Loft", 4, false, "no_open_nights"],
  ].map(([targetId, roomTypeName, maxGuests, selling, notSellingReason]) => ({
    targetId,
    roomTypeId: `room-${targetId}`,
    roomTypeName,
    mealPlan: "room_only",
    maxGuests,
    selling,
    notSellingReason,
  })),
  sync: {
    prices: { status: "ok", lastSuccessAt: hoursAgo(0.5), retryAt: null },
    bookings: {
      status: "ok",
      lastCheckedAt: hoursAgo(0.1),
      latest: {
        channel: "booking_com",
        roomTypeName: "Garden Room",
        checkIn: "2027-03-12",
        checkOut: "2027-03-14",
      },
    },
  },
};

const problem = {
  id: "26060000-0000-4000-8000-0000000000e1",
  eventType: "booking_not_imported",
  channel: "Airbnb",
  roomTypeName: "Garden Room",
  dateFrom: "2027-03-05",
  dateTo: "2027-03-07",
  reference: "HMABC123",
  errorType: "operational_inventory_unavailable",
  firstOccurredAt: hoursAgo(2),
  acknowledgedAt: null,
};
const withProblems = {
  ...connected,
  sync: {
    ...connected.sync,
    prices: { status: "retrying", lastSuccessAt: hoursAgo(1), retryAt: hoursAgo(-0.25) },
  },
  problems: [problem],
};

async function staff(page: Page, permissions: string[]) {
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: { membershipId: "staff-membership", roleKey: "hotel_manager", permissions },
    }),
  );
}

test("opens from the menu and shows a connected hotel, view only", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(viewUrl, (route) => route.fulfill({ json: connected }));

  await page.goto("/channel-manager");
  // The menu item is a link now, no longer "Soon".
  await expect(page.getByRole("link", { name: "Channel Manager" })).toHaveAttribute(
    "href",
    "/channel-manager",
  );

  await expect(page.getByRole("heading", { level: 1, name: "Channel manager" })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const channels = page.getByRole("region", { name: "Where your rooms sell" });
  await expect(
    channels.getByRole("row", { name: /Booking\.com.*4417201.*3 rooms.*Selling.*\+12%/ }),
  ).toBeVisible();
  await expect(
    channels.getByRole("row", { name: /Airbnb.*3 listings.*Selling.*\+10%/ }),
  ).toBeVisible();
  await expect(
    channels.getByText("To change a markup or add a channel, contact the vayada team."),
  ).toBeVisible();
  const rooms = page.getByRole("region", { name: "Rooms on Booking.com and Airbnb" });
  await expect(
    rooms.getByRole("row", { name: /Lake Loft.*Room only.*Up to 4.*Not selling/ }),
  ).toBeVisible();
  await expect(
    rooms.getByText(
      "Lake Loft has no open nights in the next 12 months. Open nights in the calendar to sell it.",
    ),
  ).toBeVisible();
  const sync = page.getByRole("region", { name: "Sync" });
  await expect(sync.getByText(/^Up to date · last sent today, \d\d:\d\d$/)).toBeVisible();
  await expect(sync.getByText(/^Latest: Booking\.com, Garden Room, /)).toBeVisible();
  await expect(page.getByText("Nothing needs your attention.")).toBeVisible();
  // Nothing on the page changes what Booking.com or Airbnb sell.
  for (const name of [
    "Sync now",
    "Enable connection",
    "Open channel settings",
    "Provision",
    "Save markups",
    "Mark as seen",
  ])
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  await assertHealthy();
});

test("words problems plainly and lets an account admin mark one as seen", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let seen = false;
  await page.route(viewUrl, (route) =>
    route.fulfill({
      json: seen
        ? { ...withProblems, problems: [{ ...problem, acknowledgedAt: new Date().toISOString() }] }
        : withProblems,
    }),
  );
  const acknowledged: string[] = [];
  await page.route(acknowledgeUrl, (route) => {
    acknowledged.push(new URL(route.request().url()).pathname);
    seen = true;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/channel-manager");

  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems.getByText("2 open", { exact: true })).toBeVisible();
  await expect(
    problems.getByRole("heading", { name: "A booking from Airbnb couldn't be added" }),
  ).toBeVisible();
  await expect(
    problems.getByText(/^Garden Room is already booked for .+, so this stay is sold twice\./),
  ).toBeVisible();
  await expect(
    problems.getByRole("heading", {
      name: "New prices haven't reached Booking.com and Airbnb yet",
    }),
  ).toBeVisible();
  await expect(problems.getByRole("link", { name: "Open calendar" })).toHaveAttribute(
    "href",
    "/calendar",
  );

  await problems.getByRole("button", { name: "Mark as seen" }).click();
  await expect(problems.getByText("Seen", { exact: true })).toBeVisible();
  await expect(problems.getByRole("button", { name: "Mark as seen" })).toHaveCount(0);
  expect(acknowledged).toEqual([
    `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex/alerts/${problem.id}/acknowledge`,
  ]);
  await assertHealthy();
});

test("shows staff with the Channel manager permission the same page, without Mark as seen", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await staff(page, ["pms.channel_manager.read", "pms.reservation.read"]);
  await page.route(viewUrl, (route) => route.fulfill({ json: withProblems }));
  let writes = 0;
  await page.route(acknowledgeUrl, (route) => {
    writes += 1;
    return route.abort();
  });

  await page.goto("/channel-manager");

  const problems = page.getByRole("region", { name: "Problems" });
  await expect(
    problems.getByText("2 open · only account admins can mark them as seen"),
  ).toBeVisible();
  await expect(
    problems.getByRole("heading", { name: "A booking from Airbnb couldn't be added" }),
  ).toBeVisible();
  await expect(problems.getByRole("link", { name: "Open calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark as seen" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Channel Manager" })).toBeVisible();
  expect(writes).toBe(0);
  await assertHealthy();
});

test("keeps the page from staff without the Channel manager permission", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await staff(page, ["pms.reservation.read", "pms.reservation.update"]);
  await page.route(viewUrl, (route) => route.fulfill({ status: 403, json: { code: "forbidden" } }));

  await page.goto("/channel-manager");

  await expect(
    page.getByText(
      "You don't have access to the Channel manager for this property. Ask your account admin for it.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Channel Manager" })).toHaveCount(0);
});

test("asks a hotel without a connection to contact the vayada team", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  await page.goto("/channel-manager");

  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Booking.com and Airbnb aren't connected yet" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact the vayada team" })).toHaveAttribute(
    "href",
    /\/contact$/,
  );
  await expect(page.getByRole("region", { name: "Where your rooms sell" })).toHaveCount(0);
  await assertHealthy();
});
