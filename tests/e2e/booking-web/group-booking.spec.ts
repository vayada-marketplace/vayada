import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice, orderTotal } from "../support/bookFlow";
import { watchPageHealth } from "../support/pageHealth";
import { mockGroup, STAY } from "../support/roomPickerMocks";

// VAY-2320: after choosing its rooms on the hotel page, a group says who sleeps in each room,
// books them in one booking, and sees each room on its confirmation and My booking.
const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;

async function mockGroupCheckout(page: Page) {
  await mockBookingApis(page);
  await mockGroup(page, [], ["pay_at_property"]);
  await page.route(`${hotelApi}/checkout-config`, (route) =>
    route.fulfill({ json: { addons: [], payAtPropertyEnabled: true } }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({ json: { version: "public-pricing-addons.v1", addons: [] } }),
  );
  // Each room 100.00 a stay, paid at the hotel.
  await mockAnyPrice(page);
}

async function chooseTwoRooms(page: Page, width: number) {
  await page.goto(STAY);
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Choose for room 1" })
    .click();
  await page
    .getByTestId("room-card-garden")
    .getByRole("button", { name: "Choose for room 2" })
    .click();
  await page
    .getByTestId(width === 390 ? "rooms-bar-mobile" : "rooms-bar")
    .getByRole("button", { name: "Continue" })
    .click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
}

for (const width of [1440, 390]) {
  // No page-health watch: the browser logs the sold-out 409 as a console error.
  test(`asks who sleeps in each room and sends a sold-out room back to the hotel page at ${width}px`, async ({
    page,
  }) => {
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    await mockGroupCheckout(page);
    let acceptances = 0;
    await page.route("**/bookings/quotes/*/accept", (route) => {
      acceptances++;
      return route.fulfill({
        status: 409,
        json: {
          statusCode: 409,
          error: "Conflict",
          code: "ROOMS_SOLD_OUT",
          message: "A room you chose is no longer available for these dates.",
          roomTypeIds: ["garden"],
        },
      });
    });
    await chooseTwoRooms(page, width);

    // Who's staying: each room with its rate and the guests the hotel page split.
    await expect(page.getByRole("heading", { name: "Who's staying in each room" })).toBeVisible();
    const room1 = page.getByTestId("room-guests-1");
    const room2 = page.getByTestId("room-guests-2");
    await expect(room1).toContainText("Deluxe Double Room");
    await expect(room2).toContainText("Garden Double Room");
    await expect(room1.getByText("Sleeps up to 2")).toBeVisible();
    const next = page.getByRole("button", { name: "Continue", exact: true });
    // The child's age is still to choose.
    await expect(next).toBeDisabled();
    await room2.getByLabel("Child 1: age at check-in").selectOption("5");
    await expect(room1).toContainText("€100");
    await expect(room2).toContainText("€100");
    await expect(next).toBeEnabled();

    // Each room's guests are checked against that room's limits.
    await room1.getByRole("button", { name: "More Children" }).click();
    await expect(room1.getByRole("alert")).toHaveText(
      "The Deluxe Double Room sleeps up to 2. Move a guest to another room, or add a room.",
    );
    await expect(next).toBeDisabled();
    await room1.getByRole("button", { name: "Fewer Children" }).click();
    await room2.getByRole("button", { name: "More Adults" }).click();
    await expect(room2.getByRole("alert")).toHaveText(
      "The Garden Double Room sleeps up to 2. Move a guest to another room, or add a room.",
    );
    await expect(next).toBeDisabled();
    await room2.getByRole("button", { name: "Fewer Adults" }).click();
    await expect(page.getByTestId("room-guests-step").getByRole("alert")).toHaveCount(0);
    await next.click();

    await expect(page).toHaveURL(/[?&]step=details/);
    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(orderTotal(page)).toHaveText("€200");
    await page.getByLabel(/^I agree to the cancellation policy/).check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    // Another booking took the last Garden room: say which, and keep room 1.
    const notice = page.getByTestId("rooms-sold-out");
    await expect(notice).toContainText("Garden Double Room is no longer available for your dates");
    await expect(notice).toContainText("Your other rooms stay chosen.");
    expect(acceptances).toBe(1);
    await notice.getByRole("button", { name: "Choose another room for room 2" }).click();

    await expect(page).toHaveURL(/\/(en)?\?checkIn=2026-11-10/);
    const bar = page.getByTestId(width === 390 ? "rooms-bar-mobile" : "rooms-bar");
    await expect(bar.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect(
      page.getByTestId("room-card-garden").getByRole("button", { name: "Choose for room 2" }),
    ).toBeVisible();
    if (width === 1440) {
      await expect(bar.getByTestId("rooms-bar-slot-1")).toContainText("Deluxe Double Room");
      await expect(bar.getByTestId("rooms-bar-slot-2")).toContainText("Choose a room below");
    }
  });
}

test("says when the rooms can't be priced and sends the group back to choose them", async ({
  page,
}) => {
  await mockGroupCheckout(page);
  await page.route("**/bookings/quote", (route) =>
    route.fulfill({
      status: 409,
      json: {
        statusCode: 409,
        error: "Conflict",
        message: "These rooms are no longer available for your dates.",
      },
    }),
  );
  await chooseTwoRooms(page, 1440);
  await page.getByTestId("room-guests-2").getByLabel("Child 1: age at check-in").selectOption("5");
  const notice = page.getByText("No booking was made and nothing was charged.").locator("..");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Choose another room" }).click();
  await expect(page).toHaveURL(/\/(en)?\?checkIn=2026-11-10.*rooms=2/);
  await expect(page.getByTestId("rooms-bar")).toContainText("Deluxe Double Room");
});

const groupBooking = {
  id: "booking-2320",
  bookingReference: "VAY-2320",
  status: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  hotelName: "Hotel Alpenrose",
  roomName: "Deluxe Double Room",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  checkIn: "2026-11-10",
  checkOut: "2026-11-12",
  nights: 2,
  adults: 3,
  children: 1,
  numberOfRooms: 2,
  currency: "EUR",
  totalAmount: 536,
  createdAt: "2026-10-23T08:00:00.000Z",
  bookedRooms: [
    {
      roomTypeId: "deluxe",
      roomName: "Deluxe Double Room",
      mealPlan: "room_only",
      adults: 2,
      children: 0,
      cancellation: { kind: "free_until_days_before_arrival", days: 3 },
    },
    {
      roomTypeId: "garden",
      roomName: "Garden Double Room",
      mealPlan: "breakfast",
      adults: 1,
      children: 1,
      cancellation: { kind: "non_refundable" },
    },
  ],
};

test("shows each booked room on the confirmation and on My booking", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [/\/change-request/],
  });
  await page.clock.setFixedTime(new Date("2026-10-23T08:00:00Z"));
  await mockBookingApis(page);
  await page.route(`${hotelApi}/bookings/lookup`, (route) => route.fulfill({ json: groupBooking }));
  await page.route("**/change-request**", (route) => route.fulfill({ status: 404, json: {} }));

  await page.goto(`/booking/VAY-2320?email=${encodeURIComponent(groupBooking.guestEmail)}`);
  const rooms = page.getByTestId("booked-rooms");
  await expect(rooms).toContainText("Your 2 rooms");
  await expect(rooms).toContainText("Room 1 · Deluxe Double Room");
  await expect(rooms).toContainText("Free cancellation until 7 Nov");
  await expect(rooms).toContainText("2 Adults");
  await expect(rooms).toContainText("Room 2 · Garden Double Room");
  await expect(rooms).toContainText("Breakfast included · No refund if you cancel or don't arrive");
  await expect(rooms).toContainText("1 Adult, 1 Child");

  await page.goto(
    `/my-booking?reference=VAY-2320&email=${encodeURIComponent(groupBooking.guestEmail)}`,
  );
  await expect(page.getByText("Booking Found", { exact: true })).toBeVisible();
  await expect(
    page.getByText("1 × Deluxe Double Room + 1 × Garden Double Room", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("booked-rooms")).toContainText("Room 2 · Garden Double Room");
  await assertHealthy();
});
