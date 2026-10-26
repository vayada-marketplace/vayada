import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

// VAY-2360: the confirmation page's ticket, perks, cancellation line and hotel card.
const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;
const token = "c".repeat(43);
const id = "7a3c1e52-0b4d-4f6e-9a1b-2c3d4e5f6a7b";
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const checkIn = day(12);
const booking = {
  id,
  bookingReference: "VAY-4737FF8138E241DF",
  status: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  hotelName: "Hotel Alpenrose",
  roomName: "Ocean Suite with private patio",
  bookedRooms: [
    {
      roomTypeId: "suite",
      roomName: "Ocean Suite with private patio",
      mealPlan: "room_only",
      adults: 2,
      children: 0,
      cancellation: { kind: "free_until_days_before_arrival", days: 1 },
    },
  ],
  guestFirstName: "Maya",
  guestLastName: "Perera",
  guestEmail: "maya@example.test",
  checkIn,
  checkOut: day(13),
  nights: 1,
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  currency: "EUR",
  totalAmount: 200,
  balanceAmount: 200,
  createdAt: new Date().toISOString(),
};
const stay = (places: boolean, extras: unknown = null) => ({
  extras,
  version: "booking-stay.v1",
  cancellation: {
    checkIn,
    currency: "EUR",
    timeZone: "Europe/Zurich",
    totalMinor: "20000",
    rooms: [
      {
        selectionId: "s1",
        roomTypeId: "suite",
        roomName: "Ocean Suite with private patio",
        cancellation: {
          kind: "flexible",
          terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: 1 },
        },
        subtotalMinor: "20000",
      },
    ],
  },
  places: places
    ? [
        {
          kind: "property",
          rooms: ["Ocean Suite with private patio"],
          streetAddress: "Bahnhofstrasse 12",
          area: null,
          postalCode: "3920",
          city: "Zermatt",
          countryCode: "CH",
          pin: { latitude: 46.0207, longitude: 7.7491 },
          arrivalDirections: null,
        },
      ]
    : [],
});

async function openConfirmation(
  page: Page,
  width: number,
  fields: Record<string, unknown> = {},
  nearby?: unknown,
  extras?: unknown,
) {
  await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  // Analytics choice already made, so the consent banner doesn't cover the page.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await mockBookingApis(page);
  await page.route(`${hotelApi}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: true,
        freeCancellationDays: 7,
        benefits: ["Welcome Drink on Arrival", "Ski storage", "Free Airport Transfer"],
      },
    }),
  );
  if (nearby) await page.route(`${hotelApi}/nearby`, (route) => route.fulfill({ json: nearby }));
  const pending = fields.status === "pending";
  const stayRequests: unknown[] = [];
  await page.route(`${hotelApi}/bookings/${id}/stay`, (route) => {
    stayRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: stay(!pending, extras ?? null) });
  });
  await page.route(`${hotelApi}/bookings/confirmation`, (route) =>
    route.fulfill({ json: { ...booking, ...fields } }),
  );
  await page.goto(`/confirmation?booking=${booking.bookingReference}&token=${token}`);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  return stayRequests;
}

test("shows a confirmed stay on one desktop screen", async ({ page }, testInfo) => {
  const requests = await openConfirmation(page, 1440);
  await expect(page.getByTestId("direct-perks")).toHaveText(
    "Booked direct · Welcome drink on arrival · Ski storage",
  );
  // The stay details are asked for by the booking's id and the guest's email only.
  await expect.poll(() => requests).toEqual([{ guestEmail: "maya@example.test" }]);

  // Check-in and check-out line up.
  const [checkInDay, checkOutDay] = await page.getByTestId("stay-day").all();
  expect((await checkInDay!.boundingBox())!.y).toBe((await checkOutDay!.boundingBox())!.y);
  await expect(page.getByText("1 night", { exact: true })).toBeVisible();
  await expect(page.getByText("No meals included", { exact: true })).toBeVisible();
  await expect(page.getByText("1 Room", { exact: true })).toHaveCount(0);

  const line = page.getByTestId("confirmation-cancellation");
  await expect(line).toContainText("Free cancellation until the end of");
  await expect(line).toContainText("hotel time. After that, you pay the full amount (€200");
  await expect(line).not.toContainText("first night");

  const hotel = page.getByTestId("confirmation-hotel");
  await expect(hotel).toContainText("Bahnhofstrasse 12, 3920 Zermatt, Switzerland");
  await expect(hotel.getByRole("link", { name: /^Directions to Hotel Alpenrose/ })).toHaveAttribute(
    "href",
    "https://www.google.com/maps/dir/?api=1&destination=46.0207,7.7491",
  );
  await expect(page.getByRole("button", { name: "Add to calendar" })).toBeVisible();

  // Everything fits one 1440×900 screen.
  await page.evaluate(() => document.fonts.ready);
  const bottom = await page.evaluate(() =>
    Math.max(
      ...Array.from(document.querySelectorAll("main > *")).map(
        (element) => element.getBoundingClientRect().bottom + window.scrollY,
      ),
    ),
  );
  expect(bottom).toBeLessThanOrEqual(900);
  await page.screenshot({ path: testInfo.outputPath("confirmation-1440.png") });

  await line.getByRole("button", { name: "Full policy" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancellation policy" });
  await expect(dialog).toContainText("If you cancel");
  await expect(dialog).toContainText("applies now");
  await expect(dialog.getByRole("link", { name: "Manage or cancel" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("confirmation-policy-1440.png") });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("puts the ticket first, then the hotel and next steps, on a phone", async ({
  page,
}, testInfo) => {
  await openConfirmation(page, 390);
  await expect(page.getByTestId("confirmation-cancellation")).toBeVisible();
  const top = async (locator: ReturnType<Page["getByTestId"]>) => (await locator.boundingBox())!.y;
  const ticket = await top(page.getByTestId("confirmation-cancellation"));
  const hotel = await top(page.getByTestId("confirmation-hotel"));
  const steps = await top(page.getByText("Next steps", { exact: true }));
  expect(ticket).toBeLessThan(hotel);
  expect(hotel).toBeLessThan(steps);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("confirmation-390.png"), fullPage: true });
});

test("words a request waiting for the hotel and keeps its exact place for later", async ({
  page,
}, testInfo) => {
  await openConfirmation(page, 1440, { status: "pending" });
  const line = page.getByTestId("confirmation-cancellation");
  await expect(line).toContainText("Free to withdraw until we answer.");
  await expect(line).toContainText("Once we accept: free cancellation until the end of");
  await expect(page.getByTestId("direct-perks")).toHaveCount(0);
  // Until it's confirmed, only the hotel's public area.
  const hotel = page.getByTestId("confirmation-hotel");
  await expect(hotel).toContainText("Zermatt, Switzerland");
  await expect(hotel).not.toContainText("Bahnhofstrasse");
  await page.screenshot({ path: testInfo.outputPath("confirmation-pending-1440.png") });
});

// The hotel's local tips (its Nearby places, VAY-2326), around Zermatt.
const tip = (
  id: string,
  name: string,
  category: string,
  latitude: number,
  note: string | null,
) => ({
  source: "custom",
  id,
  name,
  address: null,
  category,
  latitude,
  longitude: 7.75,
  favorite: false,
  note,
});
const NEARBY = {
  schemaVersion: 1,
  status: "ready",
  location: { mode: "exact", latitude: 46.0207, longitude: 7.7491 },
  places: [
    tip("p-lake", "Stellisee", "nature", 46.03, "Go early for the Matterhorn's reflection."),
    tip("p-bakery", "Fuchs bakery", "food", 46.021, "Our favourite breakfast spot."),
    tip("p-fondue", "Whymper-Stube", "food", 46.022, null),
  ],
  categories: [
    { id: "food", name: null, color: "orange", icon: "cake" },
    { id: "nature", name: null, color: "teal", icon: "sun" },
  ],
};

for (const width of [1440, 390]) {
  test(`opens the hotel's local tips from Directions (${width})`, async ({ page }, testInfo) => {
    const google: string[] = [];
    page.on("request", (request) => {
      if (/googleapis|gstatic/.test(request.url())) google.push(request.url());
    });
    await openConfirmation(page, width, {}, NEARBY);
    const directions = page
      .getByTestId("confirmation-hotel")
      .getByRole("link", { name: "Directions" });
    await expect(directions).toHaveAttribute(
      "href",
      new RegExp(`/booking/${booking.bookingReference}/around$`),
    );
    await directions.click();

    await expect(page.getByRole("heading", { name: "Around Hotel Alpenrose" })).toBeVisible();
    const list = page.getByRole("list", { name: "Places we recommend" });
    await expect(list.getByRole("button")).toHaveCount(3);
    await expect(list.getByRole("button").first()).toContainText("1Stellisee");
    await expect(list.getByRole("button").first()).toContainText("Beach & surf");
    await expect(list.getByRole("button").first()).toContainText("from the property");
    // The exact place this booking stays at, as on its confirmation page.
    await expect(page.getByRole("link", { name: "Directions to Hotel Alpenrose" })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=46.0207,7.7491",
    );

    // One filter for the list (and the pins once the map is shown).
    await page.getByRole("button", { name: "Food & drink", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(3);

    await list.getByRole("button", { name: /Fuchs bakery/ }).click();
    const card = page.getByTestId("nearby-place-card").filter({ visible: true });
    await expect(card).toContainText("Our favourite breakfast spot.");
    await expect(card.getByRole("link", { name: /^Directions to Fuchs bakery/ })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=46.021,7.75",
    );
    // No Google request until the guest asks for the map (VAY-2216).
    await expect(page.getByRole("button", { name: "Show map" })).toBeVisible();
    expect(google).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`around-${width}.png`),
      fullPage: width < 600,
    });

    await page.getByRole("link", { name: "Back to your booking" }).click();
    await expect(page.getByTestId("confirmation-hotel")).toBeVisible();
  });
}

// VAY-2360 part 3: extras the guest asks us for after booking; we confirm by email.
const offer = (
  addonId: string,
  name: string,
  pricingModel: string,
  unit: string,
  amount: string,
) => ({
  addonId,
  name,
  pricingModel,
  unitMinor: unit,
  amountMinor: amount,
  currency: "EUR",
});
const OFFERED = [
  offer("a1000000-0000-4000-8000-000000000001", "Airport transfer", "per_stay", "2500", "2500"),
  offer("a1000000-0000-4000-8000-000000000002", "Breakfast", "per_guest_night", "1200", "2400"),
  offer("a1000000-0000-4000-8000-000000000003", "Late check-out", "per_stay", "1000", "1000"),
];

for (const width of [1440, 390]) {
  test(`asks us for extras after booking (${width})`, async ({ page }, testInfo) => {
    const sent: Array<{ body: unknown; key: string | undefined }> = [];
    await openConfirmation(page, width, {}, undefined, { offered: OFFERED, request: null });
    // After openConfirmation: the shared mocks answer everything under the hotel's API with its profile.
    await page.route(`${hotelApi}/bookings/${id}/extras-request`, (route) => {
      sent.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      return route.fulfill({
        json: {
          version: "booking-extras-request.v1",
          request: {
            id: "e1000000-0000-4000-8000-000000000001",
            status: "pending",
            items: OFFERED.slice(0, 2),
            totalMinor: "4900",
            currency: "EUR",
            createdAt: new Date().toISOString(),
          },
        },
      });
    });
    const extras = page.getByTestId("confirmation-extras");
    await extras.getByRole("button", { name: "Airport transfer" }).click();
    await extras.getByRole("button", { name: "Breakfast" }).click();
    await expect(extras).toContainText(
      "Airport transfer €25 · Breakfast €24 (€12 per guest per night)",
    );
    await expect(extras).toContainText("nothing is charged now");
    await page.screenshot({
      path: testInfo.outputPath(`extras-picked-${width}.png`),
      fullPage: width < 600,
    });
    await extras.getByRole("button", { name: "Send request" }).click();
    await expect(extras).toContainText("We'll confirm by email; you pay at the hotel.");
    await expect(
      extras.getByRole("button", { name: "Airport transfer · requested" }),
    ).toBeDisabled();
    // Nothing else can be asked for while one request waits.
    await expect(extras.getByRole("button", { name: "Late check-out" })).toBeDisabled();
    expect(sent).toEqual([
      {
        body: {
          guestEmail: "maya@example.test",
          addonIds: [OFFERED[0]!.addonId, OFFERED[1]!.addonId],
        },
        key: expect.stringMatching(/^booking\.extras:/),
      },
    ]);
    await page.screenshot({
      path: testInfo.outputPath(`extras-requested-${width}.png`),
      fullPage: width < 600,
    });
  });
}

const waitingFor = (item: (typeof OFFERED)[number]) => ({
  id: "e1000000-0000-4000-8000-000000000002",
  status: "pending",
  items: [item],
  totalMinor: item.amountMinor,
  currency: "EUR",
  createdAt: new Date().toISOString(),
});

test("shows the extras we confirmed and offers the rest", async ({ page }) => {
  await openConfirmation(page, 1440, {}, undefined, {
    offered: OFFERED.slice(1),
    request: {
      id: "e1000000-0000-4000-8000-000000000001",
      status: "accepted",
      items: OFFERED.slice(0, 1),
      totalMinor: "2500",
      currency: "EUR",
      createdAt: new Date().toISOString(),
    },
    accepted: OFFERED.slice(0, 1),
  });
  const extras = page.getByTestId("confirmation-extras");
  await expect(extras).toContainText("Confirmed: Airport transfer. You pay €25 at the hotel.");
  await expect(extras.getByRole("button", { name: "Airport transfer" })).toHaveCount(0);
  await expect(extras.getByRole("button", { name: "Breakfast" })).toBeEnabled();
});

test("keeps what we confirmed listed while a new request waits", async ({ page }) => {
  await openConfirmation(page, 1440, {}, undefined, {
    offered: OFFERED.slice(1, 2),
    request: waitingFor(OFFERED[2]!),
    accepted: OFFERED.slice(0, 1),
  });
  const extras = page.getByTestId("confirmation-extras");
  await expect(extras).toContainText("Confirmed: Airport transfer. You pay €25 at the hotel.");
  await expect(extras).toContainText("We'll confirm by email; you pay at the hotel.");
  await expect(extras.getByRole("button", { name: "Late check-out · requested" })).toBeDisabled();
  await expect(extras.getByRole("button", { name: "Breakfast" })).toBeDisabled();
  await expect(extras.getByRole("button", { name: "Airport transfer" })).toHaveCount(0);
});

test("reads the stay again when another tab asked first", async ({ page }) => {
  await openConfirmation(page, 1440, {}, undefined, {
    offered: OFFERED,
    request: null,
    accepted: [],
  });
  const extras = page.getByTestId("confirmation-extras");
  await extras.getByRole("button", { name: "Late check-out" }).click();
  // Meanwhile another tab asked for it: the API refuses this one, and the stay now has that request.
  await page.route(`${hotelApi}/bookings/${id}/extras-request`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: "EXTRAS_REQUEST_PENDING",
        message: "An extras request is already waiting for an answer.",
      },
    }),
  );
  await page.route(`${hotelApi}/bookings/${id}/stay`, (route) =>
    route.fulfill({
      json: stay(true, {
        offered: OFFERED.slice(0, 2),
        request: waitingFor(OFFERED[2]!),
        accepted: [],
      }),
    }),
  );
  await extras.getByRole("button", { name: "Send request" }).click();
  await expect(extras.getByRole("button", { name: "Late check-out · requested" })).toBeDisabled();
  await expect(extras).toContainText("We'll confirm by email; you pay at the hotel.");
  await expect(extras).not.toContainText("Please try again");
});
