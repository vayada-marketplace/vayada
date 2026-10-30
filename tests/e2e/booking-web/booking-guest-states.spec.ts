import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";

// VAY-2163: guests must see the real state of their booking and confirm before withdrawing.
const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;
const token = "c".repeat(43);
const email = "ada@example.test";
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const booking = {
  id: "booking-1268",
  bookingReference: "VAY-1268",
  status: "confirmed",
  paymentStatus: "unpaid",
  paymentMethod: "pay_at_property",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: email,
  checkIn: day(30),
  checkOut: day(33),
  nights: 3,
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  currency: "EUR",
  totalAmount: 720,
  createdAt: "2026-09-01T10:00:00.000Z",
};
const emailNotice = /sent the details to/;
const row = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("..");

for (const width of [1440, 390]) {
  test(`asks before withdrawing a request on the booking page (${width})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // Analytics choice already made, so the consent banner doesn't cover the buttons.
    await page.addInitScript(
      ({ slug, version }) => {
        localStorage.setItem(
          `vayada_booking_analytics:${slug}`,
          JSON.stringify({ version, analytics: false }),
        );
      },
      { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
    );
    await mockBookingApis(page);
    await page.route(`${hotelApi}/bookings/lookup`, (route) =>
      route.fulfill({
        json: {
          ...booking,
          status: "pending",
          // An API from before VAY-2400 may still send this; the page no longer offers editing.
          canEditRequest: true,
          confirmationToken: token,
          hostResponseDeadline: new Date(Date.now() + 18 * 3_600_000).toISOString(),
        },
      }),
    );
    await page.route(`${hotelApi}/bookings/*/change-request**`, (route) =>
      route.fulfill({ status: 404, json: { detail: "Not found" } }),
    );
    let withdrawals = 0;
    await page.route(`${hotelApi}/bookings/*/withdraw`, (route) => {
      withdrawals++;
      return route.fulfill({ json: { status: "cancelled" } });
    });

    await page.goto(`/booking/VAY-1268?email=${encodeURIComponent(email)}`);
    const heading = page.getByRole("heading", { name: "Request sent, Ada." });
    await expect(heading).toBeVisible();
    const withdraw = page.getByRole("button", { name: /^Withdraw request/ });
    await withdraw.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`booking-actions-${width}.png`) });
    await withdraw.click();
    await page.screenshot({ path: testInfo.outputPath(`booking-withdraw-click-${width}.png`) });

    const dialog = page.getByRole("dialog", { name: "Withdraw This Request?" });
    await expect(dialog).toBeVisible();
    expect(withdrawals).toBe(0);
    await dialog.getByRole("button", { name: "Go Back" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(withdraw).toBeFocused();
    await withdraw.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(heading).toBeVisible();
    expect(withdrawals).toBe(0);

    await expect(page.getByRole("button", { name: /^Edit request/ })).toHaveCount(0);

    await withdraw.click();
    await dialog.getByRole("button", { name: "Yes, Withdraw" }).click();
    await expect(page.getByRole("heading", { name: "Your booking is cancelled." })).toBeVisible();
    expect(withdrawals).toBe(1);
  });
}

for (const [status, heading, paymentStatus, paymentText] of [
  ["cancelled", "Your booking is cancelled.", "refunded", "Refunded"],
  ["declined", "Booking Request Declined", "unpaid", "Nothing was charged"],
  ["expired", "Booking Request Expired", "unpaid", "Nothing was charged"],
] as const) {
  test(`shows a ${status} booking without an amount due or a confirmation email`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockConfirmation(page, { ...booking, status, paymentStatus });
    await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`confirmation-${status}-1440.png`),
      fullPage: true,
    });
    await expect(page.getByText("Total Due")).toHaveCount(0);
    await expect(row(page, "Total")).toContainText("€720");
    await expect(page.getByText(emailNotice)).toHaveCount(0);
    // An ended booking says what was refunded or that nothing was charged, never "Not paid yet".
    await expect(page.getByText(paymentText, { exact: true })).toBeVisible();
    await expect(page.getByText("Not paid yet")).toHaveCount(0);
  });
}

test("shows unavailable details without the email line or a second Manage Booking", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBookingApis(page);
  await page.route(`${hotelApi}/bookings/confirmation`, (route) =>
    route.fulfill({ status: 404, json: { detail: "Booking not found" } }),
  );
  await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
  await expect(page.getByText(/Booking details are unavailable/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("confirmation-details-unavailable-390.png"),
    fullPage: true,
  });
  await expect(page.getByRole("link", { name: "Manage Booking" })).toHaveCount(1);
  await expect(page.getByText(emailNotice)).toHaveCount(0);
});

for (const [shape, payment] of [
  // What the API sends after a card deposit: the balance is what's still owed.
  ["real", { paymentMethod: "card", paymentStatus: "partially_paid", balanceAmount: 535 }],
  // The older shape with deposit fields, as in the VAY-2146 captures.
  [
    "legacy",
    {
      paymentMethod: "card",
      paymentStatus: "captured",
      depositRequired: true,
      depositAmount: 230,
      balanceAmount: 535,
    },
  ],
] as const) {
  test(`shows what a deposit booking paid and still owes (${shape} shape)`, async ({
    page,
  }, testInfo) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await mockConfirmation(page, { ...booking, totalAmount: 765, ...payment });
      await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
      await expect(page.getByRole("heading", { name: "You're all set, Ada." })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`confirmation-deposit-${shape}-${width}.png`),
        fullPage: true,
      });
      await expect(page.getByText("Total Paid")).toHaveCount(0);
      await expect(page.getByText("Total Due")).toHaveCount(0);
      await expect(row(page, "Total")).toContainText("€765");
      await expect(row(page, "Deposit paid")).toContainText("€230");
      await expect(row(page, "Remaining balance due at check-in")).toContainText("€535");
      await expect(page.getByText("Partly paid by card", { exact: true })).toBeVisible();
    }
  });
}

test("shows a fully paid booking as paid in guest wording", async ({ page }) => {
  await mockConfirmation(page, { ...booking, paymentMethod: "card", paymentStatus: "captured" });
  await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
  await expect(row(page, "Total Paid")).toContainText("€720");
  await expect(page.getByText("Paid by card", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing more to pay", { exact: true })).toBeVisible();
  await expect(page.getByText(/captured/i)).toHaveCount(0);
});

// VAY-2307: a card request's hold can be only the part due now, so the page names the card and
// shows the booking's total, never an amount "on hold".
test("shows a held card request with the booking's total", async ({ page }) => {
  await mockConfirmation(page, {
    ...booking,
    status: "pending",
    paymentMethod: "card",
    paymentStatus: "authorized",
    cardBrand: "visa",
    cardLast4: "4242",
    totalAmount: 765,
    balanceAmount: 765,
  });
  await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
  await expect(page.getByRole("heading", { name: "Request sent, Ada." })).toBeVisible();
  await expect(page.getByText("Held on Visa •••• 4242", { exact: true })).toBeVisible();
  await expect(page.getByText(/only charge it if we accept your request/)).toBeVisible();
  await expect(row(page, "Total")).toContainText("€765");
  await expect(page.getByText(/on hold/i)).toHaveCount(0);
  await expect(page.getByText("Total Due")).toHaveCount(0);
});

test("shows a pending change request's dates the way guests read them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingApis(page);
  await page.route(`${hotelApi}/bookings/lookup`, (route) => route.fulfill({ json: booking }));
  await page.route(`${hotelApi}/bookings/*/change-request**`, (route) =>
    route.fulfill({
      json: {
        id: "change-1",
        bookingId: booking.id,
        status: "pending",
        requestedCheckIn: "2026-11-20",
        requestedCheckOut: "2026-11-24",
        priceDifference: 240,
        currency: "EUR",
      },
    }),
  );
  await page.goto(`/booking/VAY-1268?email=${encodeURIComponent(email)}`);
  await expect(page.getByText("Change request pending approval")).toBeVisible();
  await expect(page.getByText(/^Fri, 20 Nov 2026 → Tue, 24 Nov 2026 · \+€240$/)).toBeVisible();
});

for (const [label, change] of [
  ["Past stay", { checkIn: day(-30), checkOut: day(-27) }],
  ["Confirmed", {}],
  ["Pending", { status: "pending" }],
  ["Expired", { status: "expired" }],
  ["Checked in", { status: "checked_in", checkIn: day(-1), checkOut: day(2) }],
  ["Checked out", { status: "checked_out", checkIn: day(-30), checkOut: day(-27) }],
] as const) {
  test(`calls the booking "${label}" on My Booking`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBookingApis(page);
    await page.route(`${hotelApi}/bookings/lookup`, (route) =>
      route.fulfill({ json: { ...booking, ...change } }),
    );
    await page.goto(`/my-booking?reference=VAY-1268&email=${encodeURIComponent(email)}`);
    await expect(page.getByText("Booking Found", { exact: true })).toBeVisible();
    if (label === "Past stay")
      await page.screenshot({
        path: testInfo.outputPath("my-booking-past-stay-1440.png"),
        fullPage: true,
      });
    const status = page.getByText("Booking Found", { exact: true }).locator("xpath=..");
    await expect(status.locator("p").nth(1)).toHaveText(label);
  });
}

async function mockConfirmation(page: Page, json: Record<string, unknown>) {
  await mockBookingApis(page);
  await page.route(`${hotelApi}/bookings/confirmation`, (route) => route.fulfill({ json }));
}
