import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

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
const emailNotice = /confirmation email has been sent/;
const row = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("..");

for (const width of [1440, 390]) {
  test(`asks before withdrawing a request on the booking page (${width})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockBookingApis(page);
    await page.route(`${hotelApi}/bookings/lookup`, (route) =>
      route.fulfill({
        json: {
          ...booking,
          status: "pending",
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
    const heading = page.getByRole("heading", { name: "Booking Request Submitted" });
    await expect(heading).toBeVisible();
    const edit = page.getByRole("button", { name: "Edit Request" });
    const withdraw = page.getByRole("button", { name: "Withdraw Request" });
    await expect(edit).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`booking-pending-${width}.png`) });
    await withdraw.click();
    await page.screenshot({ path: testInfo.outputPath(`booking-withdraw-click-${width}.png`) });

    const dialog = page.getByRole("dialog", { name: "Withdraw This Request?" });
    await expect(dialog).toBeVisible();
    expect(withdrawals).toBe(0);
    await dialog.getByRole("button", { name: "Go Back" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(heading).toBeVisible();
    expect(withdrawals).toBe(0);

    await expectCentred(page.locator("div.rounded-2xl").filter({ has: heading }), [edit, withdraw]);

    await withdraw.click();
    await dialog.getByRole("button", { name: "Yes, Withdraw" }).click();
    await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();
    expect(withdrawals).toBe(1);
  });
}

for (const [status, heading] of [
  ["cancelled", "Booking Cancelled"],
  ["declined", "Booking Request Declined"],
  ["expired", "Booking Request Expired"],
] as const) {
  test(`shows a ${status} booking without an amount due or a confirmation email`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockConfirmation(page, { ...booking, status });
    await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`confirmation-${status}-1440.png`),
      fullPage: true,
    });
    await expect(page.getByText("Total Due")).toHaveCount(0);
    await expect(row(page, "Total")).toContainText("€720");
    await expect(page.getByText(emailNotice)).toHaveCount(0);
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
      await expect(page.getByRole("heading", { name: "Your booking is confirmed!" })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`confirmation-deposit-${shape}-${width}.png`),
        fullPage: true,
      });
      await expect(page.getByText("Total Paid")).toHaveCount(0);
      await expect(page.getByText("Total Due")).toHaveCount(0);
      await expect(row(page, "Total")).toContainText("€765");
      await expect(row(page, "Deposit paid")).toContainText("€230");
      await expect(row(page, "Remaining balance due at check-in")).toContainText("€535");
      await expect(row(page, "Payment Status")).toContainText("Partly paid");
    }
  });
}

test("shows a fully paid booking as paid in guest wording", async ({ page }) => {
  await mockConfirmation(page, { ...booking, paymentMethod: "card", paymentStatus: "captured" });
  await page.goto(`/confirmation?booking=VAY-1268&token=${token}`);
  await expect(row(page, "Total Paid")).toContainText("€720");
  await expect(row(page, "Payment Status")).toContainText("Paid");
  await expect(page.getByText(/captured/i)).toHaveCount(0);
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

/** Both buttons sit centred in the card: as one row, or each on its own stacked row. */
async function expectCentred(card: Locator, buttons: Locator[]) {
  const cardBox = (await card.boundingBox())!;
  const centre = cardBox.x + cardBox.width / 2;
  const boxes = await Promise.all(buttons.map(async (button) => (await button.boundingBox())!));
  if (boxes.every((box) => Math.abs(box.y - boxes[0]!.y) < 1)) {
    const left = Math.min(...boxes.map((box) => box.x));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    expect(Math.abs((left + right) / 2 - centre)).toBeLessThanOrEqual(1);
  } else {
    for (const box of boxes)
      expect(Math.abs(box.x + box.width / 2 - centre)).toBeLessThanOrEqual(1);
  }
}
