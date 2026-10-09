import { expect, test } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";

const checkIn = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const booking = {
  id: "booking-2100",
  bookingReference: "VAY-2100",
  status: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  roomTypeId: "alpine-suite",
  checkIn,
  checkOut: new Date(Date.parse(checkIn) + 2 * 86_400_000).toISOString().slice(0, 10),
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  nights: 2,
  currency: "EUR",
  totalAmount: 400,
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  createdAt: new Date().toISOString(),
};
const preview = {
  amountPaid: 0,
  refundAmount: 0,
  refundPercentage: 0,
  freeCancellationDays: 14,
  daysUntilCheckIn: 20,
  currency: "EUR",
};

// VAY-2100: an unpaid stay never reads as "you will receive a refund".
for (const [fee, message] of [
  [200, /may charge a cancellation fee of .*200/],
  [0, /No payment was collected, so there is nothing to refund\.$/],
] as const) {
  test(`unpaid cancellation preview with a fee of ${fee}`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route("**/api/booking-web/hotels/*/bookings/lookup", (route) =>
      route.fulfill({ json: booking }),
    );
    await page.route("**/api/booking-web/hotels/*/bookings/*/cancel-preview", (route) =>
      route.fulfill({
        json: {
          ...preview,
          cancellationFeeAmount: fee,
          bookedTermsOutcome: { retainedMinor: String(fee * 100) },
        },
      }),
    );
    const cancelled: unknown[] = [];
    await page.route("**/api/booking-web/hotels/*/bookings/*/cancel", (route) => {
      cancelled.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "cancelled" } });
    });
    await page.goto("/en/my-booking?reference=VAY-2100&email=ada%40example.test");
    await page.getByRole("button", { name: "Cancel Booking" }).click();
    const dialog = page.getByText("Cancel This Booking?").locator("..");
    await expect(dialog).toContainText(fee ? "Cancellation fee applies" : "Free cancellation");
    await expect(dialog.locator("p.text-sm")).toHaveText(message);
    await expect(dialog).not.toContainText("You will receive");
    // The guest confirms exactly the fee they were shown.
    await page.getByRole("button", { name: "Yes, Cancel" }).click();
    await expect(page.getByText("Your booking has been cancelled.")).toBeVisible();
    expect(cancelled).toEqual([
      expect.objectContaining({ expectedCancellationFeeMinor: String(fee * 100) }),
    ]);
  });
}
