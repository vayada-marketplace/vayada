import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

// VAY-2307: the confirmation page's next steps that are built in the browser.
const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;
const token = "c".repeat(43);
const booking = {
  id: "booking-1268",
  bookingReference: "VAY-1268",
  status: "confirmed",
  paymentStatus: "paid",
  paymentMethod: "card",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  checkIn: "2026-09-12",
  checkOut: "2026-09-15",
  nights: 3,
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  currency: "EUR",
  totalAmount: 720,
  balanceAmount: 0,
  createdAt: "2026-09-01T10:00:00.000Z",
};

async function openConfirmation(page: Page, fields: Record<string, unknown> = {}) {
  await mockBookingApis(page);
  await page.route(`${hotelApi}/bookings/confirmation`, (route) =>
    route.fulfill({ json: { ...booking, ...fields } }),
  );
  await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
}

test("adds a confirmed stay to the calendar as one all-day event", async ({ page }) => {
  await openConfirmation(page);
  const add = page.getByRole("button", { name: /^Add to calendar/ });
  await expect(add).toContainText(/Sat, 12 Sept? 2026 – Tue, 15 Sept? 2026/);
  const [download] = await Promise.all([page.waitForEvent("download"), add.click()]);
  expect(download.suggestedFilename()).toBe("VAY-1268.ics");
  const lines = (await readFile(await download.path(), "utf8")).split("\r\n");
  expect(lines).toContain("DTSTART;VALUE=DATE:20260912");
  // The end is exclusive: the event covers the check-out day too.
  expect(lines).toContain("DTEND;VALUE=DATE:20260916");
  expect(lines).toContain("SUMMARY:Hotel Alpenrose");
  expect(lines).toContain("LOCATION:Zermatt");
  expect(lines).toContain(
    "DESCRIPTION:Check-in: 15:00\\nCheck-out: 11:00\\nBooking Reference: VAY-1268",
  );
});

for (const status of ["pending", "cancelled"] as const) {
  test(`offers no calendar event for a ${status} booking`, async ({ page }) => {
    await openConfirmation(page, { status });
    await expect(page.getByText("VAY-1268", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add to calendar/ })).toHaveCount(0);
  });
}
