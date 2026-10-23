import { expect, test } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2320: a booking whose rooms have different terms is cancelled online, each room under its
// own terms; before the guest confirms, the dialog lists what each room costs or gives back.
const checkIn = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const booking = {
  id: "booking-2320",
  bookingReference: "VAY-2320",
  status: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  hotelName: "Hotel Alpenrose",
  roomName: "Deluxe Double Room",
  roomTypeId: "deluxe",
  checkIn,
  checkOut: new Date(Date.parse(checkIn) + 2 * 86_400_000).toISOString().slice(0, 10),
  adults: 3,
  children: 1,
  numberOfRooms: 2,
  nights: 2,
  currency: "EUR",
  totalAmount: 512,
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  createdAt: new Date().toISOString(),
};
const rooms = [
  {
    roomName: "Deluxe Double Room",
    rule: "free_until_deadline",
    refundPercent: 100,
    refundAmount: 298,
    keptAmount: 0,
  },
  {
    roomName: "Garden Double Room",
    rule: "non_refundable",
    refundPercent: 0,
    refundAmount: 0,
    keptAmount: 214,
  },
];
const preview = {
  amountPaid: 0,
  refundAmount: 0,
  refundPercentage: 0,
  cancellationFeeAmount: 214,
  freeCancellationDays: 0,
  daysUntilCheckIn: 20,
  currency: "EUR",
  bookedTermsOutcome: { retainedMinor: "21400" },
  rooms,
};
const lookup = "**/api/booking-web/hotels/*/bookings/lookup";
const cancelPreview = "**/api/booking-web/hotels/*/bookings/*/cancel-preview";

for (const width of [1440, 390]) {
  test(`lists each room's fee before a stay paid at the hotel is cancelled at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);
    await page.route(lookup, (route) => route.fulfill({ json: booking }));
    await page.route(cancelPreview, (route) => route.fulfill({ json: preview }));
    const cancelled: unknown[] = [];
    await page.route("**/api/booking-web/hotels/*/bookings/*/cancel", (route) => {
      cancelled.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "cancelled" } });
    });
    await page.goto("/en/my-booking?reference=VAY-2320&email=ada%40example.test");
    await page.getByRole("button", { name: "Cancel Booking" }).click();

    const list = page.getByTestId("cancel-rooms");
    await expect(list).toContainText("Room 1 · Deluxe Double RoomFree cancellationNo fee");
    await expect(list).toContainText("Room 2 · Garden Double RoomNon-refundable€214 fee");
    await expect(list).toContainText("The hotel may charge€214");
    // The booking-level sentence stays: nothing was paid, so nothing is refunded.
    await expect(page.getByText(/may charge a cancellation fee of .*214/)).toBeVisible();
    await page.getByRole("button", { name: "Yes, Cancel" }).click();
    await expect(page.getByText("Your booking has been cancelled.")).toBeVisible();
    expect(cancelled).toEqual([expect.objectContaining({ expectedCancellationFeeMinor: "21400" })]);
    await assertHealthy();
  });
}

test("says what goes back to the card and what the hotel keeps, room by room", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await page.route(lookup, (route) =>
    route.fulfill({
      json: { ...booking, paymentStatus: "paid", paymentMethod: "card", balanceAmount: 0 },
    }),
  );
  await page.route(cancelPreview, (route) =>
    route.fulfill({
      json: { ...preview, amountPaid: 512, refundAmount: 298, refundPercentage: 58 },
    }),
  );
  await page.goto("/en/my-booking?reference=VAY-2320&email=ada%40example.test");
  await page.getByRole("button", { name: "Cancel Booking" }).click();
  const list = page.getByTestId("cancel-rooms");
  await expect(list).toContainText(
    "Room 1 · Deluxe Double RoomFree cancellation€298 backHotel keeps €0",
  );
  await expect(list).toContainText(
    "Room 2 · Garden Double RoomNon-refundable€0 backHotel keeps €214",
  );
  await expect(list).toContainText("Back to your card€298");
  // A deposit's refund is the booking's alone: each room says only what the hotel keeps.
  await page.unroute(cancelPreview);
  await page.route(cancelPreview, (route) =>
    route.fulfill({
      json: { ...preview, amountPaid: 154, refundAmount: 0, refundPercentage: 0 },
    }),
  );
  await page.getByRole("button", { name: "Go Back" }).click();
  await page.getByRole("button", { name: "Cancel Booking" }).click();
  await expect(list).toContainText("Room 2 · Garden Double RoomNon-refundableHotel keeps €214");
  expect(await list.textContent()).not.toMatch(/\d back/);
  await assertHealthy();
});

test("keeps today's dialog for one room", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(lookup, (route) => route.fulfill({ json: { ...booking, numberOfRooms: 1 } }));
  await page.route(cancelPreview, (route) =>
    route.fulfill({ json: { ...preview, rooms: undefined } }),
  );
  await page.goto("/en/my-booking?reference=VAY-2320&email=ada%40example.test");
  await page.getByRole("button", { name: "Cancel Booking" }).click();
  await expect(page.getByText("Cancel This Booking?")).toBeVisible();
  await expect(page.getByTestId("cancel-rooms")).toHaveCount(0);
});
