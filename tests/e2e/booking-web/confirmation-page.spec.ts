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
const stay = (places: boolean) => ({
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

async function openConfirmation(page: Page, width: number, fields: Record<string, unknown> = {}) {
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
  const pending = fields.status === "pending";
  const stayRequests: unknown[] = [];
  await page.route(`${hotelApi}/bookings/${id}/stay`, (route) => {
    stayRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: stay(!pending) });
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
