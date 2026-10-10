import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("fetches protected bank instructions after submission and refresh without storing them", async ({
  page,
}) => {
  await mockBookingApis(page);
  const token = "c".repeat(43);
  const booking = {
    id: "bank-booking",
    bookingReference: "VAY-BANK",
    status: "pending_payment",
    paymentStatus: "unpaid",
    paymentMethod: "bank_transfer",
    hotelName: "Hotel Alpenrose",
    roomName: "Alpine Suite",
    guestFirstName: "Ada",
    guestLastName: "Lovelace",
    guestEmail: "ada@example.test",
    checkIn: "2026-10-12",
    checkOut: "2026-10-15",
    nights: 3,
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    currency: "EUR",
    totalAmount: 720,
    createdAt: "2026-09-05T00:00:00Z",
  };
  await page.addInitScript(
    (value) => sessionStorage.setItem("lastBooking", JSON.stringify(value)),
    booking,
  );
  let calls = 0;
  let instructionsAvailable = true;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({
        bookingReference: "VAY-BANK",
        confirmationToken: token,
      });
      await route.fulfill({
        json: {
          ...booking,
          bankTransferDetails: instructionsAvailable ? "IBAN: DE89370400440532013000" : null,
        },
      });
    },
  );
  await page.goto(`/confirmation?booking=VAY-BANK&token=${token}`);
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(
    "DE89370400440532013000",
  );
  await page.reload();
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toBeVisible();
  expect(calls).toBe(2);
  instructionsAvailable = false;
  await page.reload();
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Manage Booking", exact: true }).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(
    "DE89370400440532013000",
  );
});
