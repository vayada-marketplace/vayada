import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const confirmationToken = "c".repeat(43);
const booking = {
  id: "booking-1268",
  bookingReference: "VAY-1268",
  status: "confirmed",
  paymentStatus: "paid",
  paymentMethod: "card",
  cardBrand: "visa",
  cardLast4: "4242",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  unitNames: ["Suite 204", "Suite 205"],
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  checkIn: "2026-09-12",
  checkOut: "2026-09-15",
  nights: 3,
  adults: 2,
  children: 0,
  numberOfRooms: 2,
  currency: "EUR",
  totalAmount: 720,
  createdAt: "2026-09-01T10:00:00.000Z",
};

test("finds a booking from the shared footer on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBookingApis(page);
  let lookupBody: unknown;
  let confirmationBody: unknown;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      lookupBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ...booking,
          confirmationToken,
          confirmationTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
    },
  );
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      confirmationBody = route.request().postDataJSON();
      await route.fulfill({ json: booking });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(358);
  expect(bounds?.x).toBeGreaterThanOrEqual(16);

  await dialog.getByLabel("Booking Reference").fill("vay-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/confirmation\\?booking=VAY-1268&token=${confirmationToken}$`),
  );
  await expect(page.getByRole("heading", { name: "You're all set, Ada." })).toBeVisible();
  await expect(page.getByText("2× Alpine Suite")).toBeVisible();
  // VAY-2361: guests see the room type, never the room the hotel assigned (it can still change).
  await expect(page.getByText("Suite 204, Suite 205")).toHaveCount(0);
  // Stay dates read as days, not as raw YYYY-MM-DD; the year sits under them (VAY-2360).
  await expect(page.getByText(/^Sat, 12 Sept?$/)).toBeVisible();
  await expect(page.getByText(/^Tue, 15 Sept?$/)).toBeVisible();
  await expect(page.getByText(/^2026 · from 15:00$/)).toBeVisible();
  await expect(page.getByText("Paid with Visa •••• 4242", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Email", exact: true })).toHaveAttribute(
    "href",
    "mailto:stay@alpenrose.test",
  );
  await expect(page.getByRole("link", { name: "Call", exact: true })).toHaveAttribute(
    "href",
    "tel:+41440000000",
  );
  await expect(page.getByRole("link", { name: /^Manage or cancel/ })).not.toHaveAttribute(
    "href",
    /email=/,
  );
  // Guest date changes can't be repriced online yet, so there's no "Request changes" (VAY-2110).
  await expect(page.getByRole("link", { name: /^Request changes/ })).toHaveCount(0);
  expect(lookupBody).toEqual({
    bookingReference: "VAY-1268",
    guestEmail: "ada@example.test",
  });
  expect(confirmationBody).toEqual({
    bookingReference: "VAY-1268",
    confirmationToken,
  });

  await page.getByRole("link", { name: /^Manage or cancel/ }).click();
  await expect(page).toHaveURL(/\/my-booking\?reference=VAY-1268$/);
  await expect(page.getByText("Booking Found")).toBeVisible();
  await expect(page.getByText(/^Sat, 12 Sept? 2026, /)).toBeVisible();
});

for (const [paymentMethod, label] of [
  ["pay_at_property", "Pay at the hotel"],
  ["credit_card", "Credit Card"],
  ["bank_transfer", "Bank Transfer"],
  ["cash", "Cash"],
] as const) {
  test(`shows ${label} instead of ${paymentMethod} on the guest booking review`, async ({
    page,
  }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({ json: { ...booking, paymentMethod, paymentStatus: "unpaid" } });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);

    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(paymentMethod, { exact: true })).toHaveCount(0);
  });
}

test("does not expose an unknown payment identifier on the guest booking review", async ({
  page,
}) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({ json: { ...booking, paymentMethod: "future_wallet" } });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);

  await expect(page.getByText("future_wallet", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Payment", { exact: true })).toHaveCount(0);
});

for (const status of ["pending", "confirmed"] as const) {
  test(`aligns add-ons in the value column for a ${status} booking`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({
          json: {
            ...booking,
            status,
            addonIds: ["airport-transfer", "scooter-rental"],
            addonNames: ["Airport Transfer", "Scooter Rental"],
            addonQuantities: { "scooter-rental": 2 },
          },
        });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);

    // VAY-2307: the add-ons list under their label in the ticket, one per line.
    const addons = page.getByTestId("confirmation-addons");
    await expect(addons.getByText("Add-ons", { exact: true })).toBeVisible();
    const items = addons.getByRole("listitem");
    await expect(items).toHaveText(["Airport Transfer", /Scooter Rental.*× 2/]);
    const itemBoxes = await items.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    );
    expect(itemBoxes[1]!.y).toBeGreaterThan(itemBoxes[0]!.y);
    expect(Math.abs(itemBoxes[1]!.x - itemBoxes[0]!.x)).toBeLessThanOrEqual(1);
  });
}

// VAY-2408: opened from the email in a fresh browser (nothing saved from checkout), the page lists
// the extras the lookup sends, with their days, as right after checkout.
test("lists the booked extras and their days from the lookup", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`, (route) =>
    route.fulfill({
      json: {
        ...booking,
        checkIn: "2026-11-05",
        checkOut: "2026-11-08",
        balanceAmount: 0,
        addonIds: ["breakfast", "late-checkout"],
        addonNames: ["Garden breakfast", "Late check-out"],
        addonQuantities: { breakfast: 2, "late-checkout": 1 },
        addonDates: {
          breakfast: ["2026-11-05", "2026-11-06", "2026-11-07"],
          "late-checkout": ["2026-11-08"],
        },
      },
    }),
  );

  await page.goto(`/booking/VAY-1268?email=${encodeURIComponent(booking.guestEmail)}`);

  await expect(page.getByTestId("confirmation-addons").getByRole("listitem")).toHaveText([
    /^Garden breakfast.*× 2.*5 Nov – 7 Nov$/,
    /^Late check-out.*Sun 8 Nov$/,
  ]);
});

test("keeps booking lookup failures generic", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      await route.fulfill({
        status: 404,
        json: { detail: "Property hotel-alpenrose does not contain reference VAY-SECRET" },
      });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await dialog.getByLabel("Booking Reference").fill("VAY-SECRET");
  await dialog.getByLabel("Email Address").fill("wrong@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "No booking found with that reference and email.",
  );
  await expect(dialog).not.toContainText("hotel-alpenrose");
  await expect(dialog.getByRole("button", { name: "Find My Booking" })).toBeVisible();
});

test("explains rate limits without claiming the booking is missing", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      await route.fulfill({ status: 429, json: { detail: "Too many attempts" } });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await dialog.getByLabel("Booking Reference").fill("VAY-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "Too many attempts. Please wait a minute and try again.",
  );
});

test("traps focus, restores the footer trigger, and ignores a dismissed lookup", async ({
  page,
}) => {
  await mockBookingApis(page);
  let releaseLookup = () => {};
  let markLookupStarted = () => {};
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      markLookupStarted();
      await new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      await route.fulfill({
        json: {
          ...booking,
          confirmationToken,
          confirmationTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
    },
  );

  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Find My Booking" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await expect(dialog.getByLabel("Booking Reference")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByLabel("Booking Reference").fill("VAY-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();
  await lookupStarted;
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  releaseLookup();
  await page.waitForTimeout(100);
  await expect(page).toHaveURL(/\/$/);
});

test("shows a neutral recovery state for an invalid confirmation token", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({ status: 404, json: { detail: "Booking not found" } });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByText(/Booking details are unavailable/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Request sent/ })).toHaveCount(0);
});

for (const [status, heading] of [
  ["pending", "Request sent, Ada."],
  ["cancelled", "Your booking is cancelled."],
  ["declined", "Booking Request Declined"],
  ["expired", "Booking Request Expired"],
  ["checked_in", "You're checked in"],
  ["checked_out", "You've checked out"],
] as const) {
  test(`shows the ${status} booking state`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({
          json: {
            ...booking,
            status,
            ...(status === "cancelled" ? { cancelledAt: "2026-09-04T22:30:00.000Z" } : {}),
          },
        });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("VAY-1268", { exact: true })).toBeVisible();
    if (status === "cancelled") {
      await expect(page.getByText(/^Cancelled on 5 Sept? 2026\.$/)).toBeVisible();
    }
  });
}

for (const status of ["pending", "confirmed"] as const) {
  test(`shows bank transfer instructions and deadline for an unpaid ${status} booking`, async ({
    page,
  }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({
          json: {
            ...booking,
            status,
            paymentStatus: "unpaid",
            paymentMethod: "bank_transfer",
            bankTransferDetails: "IBAN: CH93 0076 2011 6238 5295 7",
            paymentDeadline: "2026-09-02T10:00:00.000Z",
          },
        });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
    await expect(page.getByText("Bank transfer pending")).toBeVisible();
    await expect(page.getByText("IBAN: CH93 0076 2011 6238 5295 7")).toBeVisible();
    await expect(
      page.getByText(/Payment deadline: 2 Sept? 2026, 12:00 (CEST|GMT\+2)/),
    ).toBeVisible();
    await expect(page.getByText("Total Due")).toBeVisible();
  });
}

test("does not request a bank transfer after a booking ends", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({
        json: {
          ...booking,
          status: "cancelled",
          paymentStatus: "unpaid",
          paymentMethod: "bank_transfer",
          bankTransferDetails: "IBAN: CH93 0076 2011 6238 5295 7",
          paymentDeadline: "2026-09-02T10:00:00.000Z",
        },
      });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByRole("heading", { name: "Your booking is cancelled." })).toBeVisible();
  await expect(page.getByText("Bank transfer pending")).toHaveCount(0);
  await expect(page.getByText(/IBAN:/)).toHaveCount(0);
});

test("keeps polling statuses in the public status vocabulary", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-01T10:00:00.000Z") });
  await mockBookingApis(page);
  let statusReads = 0;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({ json: { ...booking, status: "pending" } });
    },
  );
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/status**`,
    async (route) => {
      statusReads += 1;
      await route.fulfill({
        json: {
          bookingReference: booking.bookingReference,
          status: statusReads === 1 ? "pending" : "cancelled",
          paymentStatus: "unpaid",
        },
      });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByRole("heading", { name: "Request sent, Ada." })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect.poll(() => statusReads).toBe(1);
  await expect(page.getByRole("heading", { name: "Request sent, Ada." })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "Your booking is cancelled." })).toBeVisible();
});

// VAY-2307: once a polled request is answered, the payment line shows what was charged, not the hold.
test("reloads what was paid once a polled request is accepted", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-01T10:00:00.000Z") });
  await mockBookingApis(page);
  const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;
  await page.route(`${hotelApi}/bookings/confirmation`, (route) =>
    route.fulfill({
      json: { ...booking, status: "pending", paymentStatus: "authorized", balanceAmount: 720 },
    }),
  );
  await page.route(`${hotelApi}/bookings/status**`, (route) =>
    route.fulfill({
      json: {
        bookingReference: booking.bookingReference,
        status: "confirmed",
        paymentStatus: "paid",
      },
    }),
  );
  await page.route(`${hotelApi}/bookings/lookup`, (route) =>
    route.fulfill({ json: { ...booking, paymentStatus: "paid", balanceAmount: 0 } }),
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByText("Held on Visa •••• 4242", { exact: true })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "You're all set, Ada." })).toBeVisible();
  await expect(page.getByText("Paid with Visa •••• 4242", { exact: true })).toBeVisible();
  await expect(page.getByText("Held on Visa •••• 4242", { exact: true })).toHaveCount(0);
});
