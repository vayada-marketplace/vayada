import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";

// VAY-2308: My Booking shows why a booking can't be cancelled online, before the guest clicks,
// and keeps the generic text for real failures only.
const today = new Date().toISOString().slice(0, 10);
const booking = {
  id: "booking-2308",
  bookingReference: "VAY-2308",
  status: "confirmed",
  paymentStatus: "paid",
  paymentMethod: "card",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  roomTypeId: "alpine-suite",
  checkIn: today,
  checkOut: new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10),
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  nights: 1,
  currency: "EUR",
  totalAmount: 200,
  balanceAmount: 0,
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  createdAt: new Date().toISOString(),
};
const refusal = (message: string, code?: string) => ({
  status: 409,
  json: { statusCode: 409, error: "Conflict", message, ...(code ? { code } : {}) },
});

/** Mocks lookup and cancel-preview; returns the cancel requests the page sent. */
async function openMyBooking(
  page: Page,
  preview: { status: number; json: unknown },
  locale = "en",
): Promise<unknown[]> {
  await mockBookingApis(page);
  await page.route("**/api/booking-web/hotels/*/bookings/lookup", (route) =>
    route.fulfill({ json: booking }),
  );
  await page.route("**/api/booking-web/hotels/*/bookings/*/cancel-preview", (route) =>
    route.fulfill(preview),
  );
  const cancels: unknown[] = [];
  await page.route("**/api/booking-web/hotels/*/bookings/*/cancel", (route) => {
    cancels.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: "cancelled" } });
  });
  await page.goto(`/${locale}/my-booking?reference=VAY-2308&email=ada%40example.test`);
  await expect(
    page.getByText(locale === "de" ? "Buchung gefunden" : "Booking Found", { exact: true }),
  ).toBeVisible();
  return cancels;
}

for (const [name, response, reason] of [
  [
    "non-refundable",
    refusal(
      "This booked rate is non-refundable and cannot be cancelled online.",
      "BOOKING_CANCEL_NON_REFUNDABLE",
    ),
    "This booking is non-refundable, so it can't be cancelled online. Please contact the hotel.",
  ],
  [
    "past the free-cancellation deadline",
    refusal(
      "This booking's free-cancellation period has expired. Contact the property.",
      "BOOKING_CANCEL_DEADLINE_PASSED",
    ),
    "The free-cancellation period for this booking has ended, so it can't be cancelled online. Please contact the hotel.",
  ],
  [
    "refused by an API without codes yet",
    refusal("This booking's free-cancellation period has expired. Contact the property."),
    "This booking's free-cancellation period has expired. Contact the property.",
  ],
] as const) {
  test(`a booking ${name} says why and offers the hotel instead of Cancel`, async ({ page }) => {
    const cancels = await openMyBooking(page, response);
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Contact the Hotel" })).toHaveAttribute(
      "href",
      "mailto:stay@alpenrose.test",
    );
    await expect(page.getByRole("button", { name: "Cancel Booking" })).toHaveCount(0);
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    expect(cancels).toEqual([]);
  });
}

test("the reason reads in the page's language", async ({ page }) => {
  await openMyBooking(
    page,
    refusal(
      "This booked rate is non-refundable and cannot be cancelled online.",
      "BOOKING_CANCEL_NON_REFUNDABLE",
    ),
    "de",
  );
  await expect(
    page.getByText(
      "Diese Buchung ist nicht erstattungsfähig und kann daher nicht online storniert werden. Bitte kontaktieren Sie die Unterkunft.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Unterkunft kontaktieren" })).toBeVisible();
});

test("a server failure keeps Cancel and shows only the generic text", async ({ page }) => {
  const cancels = await openMyBooking(page, {
    status: 500,
    json: { statusCode: 500, error: "Internal Server Error", message: "relation does not exist" },
  });
  const cancel = page.getByRole("button", { name: "Cancel Booking" });
  await expect(cancel).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact the Hotel" })).toHaveCount(0);
  await cancel.click();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  await expect(page.getByText("relation does not exist")).toHaveCount(0);
  await expect(page.getByText("Cancel This Booking?")).toHaveCount(0);
  expect(cancels).toEqual([]);
});

test("a refusal that arrives on the click replaces Cancel too", async ({ page }) => {
  let previews = 0;
  await openMyBooking(page, { status: 503, json: { statusCode: 503, message: "down" } });
  // The check at lookup has answered (503) and left the button usable.
  await expect(page.getByRole("button", { name: "Cancel Booking" })).toBeEnabled();
  await page.unroute("**/api/booking-web/hotels/*/bookings/*/cancel-preview");
  await page.route("**/api/booking-web/hotels/*/bookings/*/cancel-preview", (route) => {
    previews++;
    return route.fulfill(
      refusal(
        "This booking's check-in date has passed. Contact the property.",
        "BOOKING_CANCEL_CHECK_IN_PASSED",
      ),
    );
  });
  await page.getByRole("button", { name: "Cancel Booking" }).click();
  await expect(
    page.getByText(
      "The check-in date has passed, so this booking can't be cancelled online. Please contact the hotel.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel Booking" })).toHaveCount(0);
  expect(previews).toBe(1);
});

test("a busy answer keeps Cancel, since asking again can work", async ({ page }) => {
  await openMyBooking(
    page,
    refusal("Someone else is changing this right now. Try again in a moment.", "busy_try_again"),
  );
  await expect(page.getByRole("button", { name: "Cancel Booking" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Contact the Hotel" })).toHaveCount(0);
});

test("a slow check shows the booking at once and frees Cancel after 8 s", async ({ page }) => {
  await mockBookingApis(page);
  await page.route("**/api/booking-web/hotels/*/bookings/lookup", (route) =>
    route.fulfill({ json: booking }),
  );
  // Never answers.
  await page.route("**/api/booking-web/hotels/*/bookings/*/cancel-preview", () => {});
  await page.goto("/en/my-booking?reference=VAY-2308&email=ada%40example.test");
  await expect(page.getByText("Booking Found", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpine Suite")).toBeVisible();
  await expect(page.getByRole("button", { name: "...", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel Booking" })).toBeEnabled({
    timeout: 15_000,
  });
});

test("a refused withdraw replaces the Withdraw button with the reason", async ({ page }) => {
  await mockBookingApis(page);
  await page.route("**/api/booking-web/hotels/*/bookings/lookup", (route) =>
    route.fulfill({ json: { ...booking, status: "pending", paymentStatus: "authorized" } }),
  );
  await page.route("**/api/booking-web/hotels/*/bookings/*/withdraw", (route) =>
    route.fulfill(
      refusal(
        "This booking's card payment can't be withdrawn online. Please contact the hotel.",
        "BOOKING_WITHDRAW_NOT_ONLINE",
      ),
    ),
  );
  await page.goto("/en/my-booking?reference=VAY-2308&email=ada%40example.test");
  await page.getByRole("button", { name: "Withdraw Request" }).click();
  await page.getByRole("button", { name: "Yes, Withdraw" }).click();
  await expect(
    page.getByText("This request can't be withdrawn online. Please contact the hotel."),
  ).toBeVisible();
  await expect(page.getByText("Withdraw This Request?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Withdraw Request" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Contact the Hotel" })).toBeVisible();
});

test("an unknown reference reads as not found, not as a failure", async ({ page }) => {
  await mockBookingApis(page);
  await page.route("**/api/booking-web/hotels/*/bookings/lookup", (route) =>
    route.fulfill({
      status: 404,
      json: { statusCode: 404, error: "Not Found", message: "Booking not found." },
    }),
  );
  await page.goto("/en/my-booking?reference=VAY-0000&email=ada%40example.test");
  await expect(page.getByText("No booking found with that reference and email.")).toBeVisible();
});
