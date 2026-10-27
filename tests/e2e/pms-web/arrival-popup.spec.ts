import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { checkinSettingsResponse, defaultCheckinSettings } from "../support/checkinSettingsMocks";

// VAY-2372: the arrival popup, as approved in Paper (VAY-2372-2374 Check-in, 2026-10-26).
test.use({ timezoneId: "Europe/Vienna" });

const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
const grace = {
  guestId: "guest_grace",
  guestBookingId: PMS_WEB_RESERVATION_ID,
  displayName: "Grace Hopper",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  phone: null,
  countryCode: "US",
  countryCodeRaw: null,
  countryCodeReviewRequired: false,
};
const room = (roomNumber: string, position: number, checkOut: string) => ({
  ...pmsWebReservation.assignments[0]!,
  assignmentId: `assignment_${roomNumber}`,
  roomId: `room_${roomNumber}`,
  roomNumber,
  position,
  channel: "booking.com",
  stay: { checkIn: "2026-08-15", checkOut, adults: 2, children: 0 },
});
// Four adults in two rooms, one leaving two nights earlier; nothing paid; a special request.
const arrival = {
  ...pmsWebReservation,
  source: "channel",
  stay: { checkIn: "2026-08-15", checkOut: "2026-08-19", adults: 4, children: 0 },
  primaryGuest: {
    ...pmsWebReservation.primaryGuest,
    specialRequests: "We arrive late, around 11 pm. Could you leave the keys at the bar?",
  },
  assignments: [room("104", 1, "2026-08-17"), room("101", 2, "2026-08-19")],
  pricing: {
    totalAmount: { amountDecimal: "600.00", currency: "EUR" },
    balanceAmount: { amountDecimal: "600.00", currency: "EUR" },
  },
  payment: { method: null, expectedMethod: "pay_at_property", status: "unpaid" },
  additionalGuestCount: 1,
};
const registration = (guestId: string, role: string, filledFields: string[]) => ({
  guestId,
  role,
  assignmentId: null,
  dateOfBirth: null,
  documentType: null,
  documentNumber: null,
  gender: null,
  staffNotes: null,
  filledFields,
  updatedAt: null,
});

async function mockArrival(
  page: Page,
  reservation: Record<string, unknown>,
  settings: Record<string, unknown> = {},
) {
  await page.clock.install({ time: new Date("2026-08-15T08:00:00Z") });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`${base}/notes`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/additional-guests`, (route) =>
    route.fulfill({ json: { items: [grace] } }),
  );
  // Ada is fully registered; Grace has only her date of birth.
  await page.route(`${base}/guest-registrations`, (route) =>
    route.fulfill({
      json: {
        guestBookingId: PMS_WEB_RESERVATION_ID,
        canReadIdentity: true,
        guests: [
          registration("guest_ada", "booker", ["documentType", "documentNumber", "dateOfBirth"]),
          registration(grace.guestId, "additional_guest", ["dateOfBirth"]),
        ],
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-settings`, (route) =>
    route.fulfill({ json: checkinSettingsResponse(settings) }),
  );
  await page.route(base, (route) => route.fulfill({ json: { item: reservation } }));
  const reservations = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
  await page.unroute(reservations);
  await page.route(reservations, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [reservation],
        pagination: { total: 1, limit: 500, offset: 0 },
        sourceFreshness: {},
      },
    }),
  );
}

async function openPopup(page: Page) {
  await page.goto("/dashboard");
  await page
    .locator('section[aria-labelledby="arrivals-heading"]')
    .getByRole("button", { name: /Ada Lovelace/ })
    .click();
  return page.getByRole("dialog", { name: "Ada Lovelace" });
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`shows who still has to register, what is owed and every room at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height });
    await mockArrival(page, arrival);
    const popup = await openPopup(page);

    await expect(popup.getByText("VAY-ADA · Booking.com")).toBeVisible();
    await expect(popup.getByText("Arriving today · 3:00 PM")).toBeVisible();
    await expect(popup.getByText("4 nights · 4 adults · 2 rooms")).toBeVisible();
    await expect(popup.getByText("1 of 4 guests registered")).toBeVisible();
    await expect(
      popup.getByText("Grace Hopper’s ID is missing · Guest 3 and Guest 4 have no details yet"),
    ).toBeVisible();
    await expect(popup.getByText(/^€600(\.00)? due$/)).toBeVisible();
    await expect(popup.getByText("Pay at Property · nothing paid yet")).toBeVisible();
    await expect(popup.getByText(/We arrive late, around 11 pm/)).toBeVisible();

    const rooms = popup.getByRole("listitem").filter({ hasText: /Room 10[14]/ });
    await expect(rooms).toHaveCount(2);
    await expect(rooms.nth(0)).toContainText("Room 104 · 2 guests");
    await expect(rooms.nth(0)).toContainText("2 nights · leaves earlier");
    await expect(rooms.nth(1)).toContainText("Room 101 · 2 guests");
    await expect(rooms.nth(1)).toContainText("4 nights");
    await expect(rooms.nth(1)).not.toContainText("leaves earlier");

    await expect(popup.getByRole("link", { name: "Start check-in" })).toHaveAttribute(
      "href",
      `/check-in/${PMS_WEB_RESERVATION_ID}`,
    );
    await expect(popup.getByRole("link", { name: "View booking" })).toHaveAttribute(
      "href",
      `/bookings/${PMS_WEB_RESERVATION_ID}`,
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await testInfo.attach(`arrival-popup-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Focus is in the dialog and stays there; Escape closes it and focus returns to the guest row.
    await expect(popup).toBeFocused();
    for (let tab = 0; tab < 4; tab += 1) await page.keyboard.press("Tab");
    await expect(popup.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(
      page.locator('section[aria-labelledby="arrivals-heading"]').getByRole("button", {
        name: /Ada Lovelace/,
      }),
    ).toBeFocused();
    await assertHealthy();
  });
}

test("counts registrations by Settings → Check-in and shows a settled stay", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  // Only the booker registers, and the document is optional: Ada's names and country are enough.
  await mockArrival(
    page,
    {
      ...arrival,
      primaryGuest: { ...arrival.primaryGuest, specialRequests: null },
      pricing: {
        totalAmount: { amountDecimal: "600.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
      },
      payment: { method: "bank_transfer", expectedMethod: "bank_transfer", status: "paid" },
    },
    {
      registrationScope: "booker",
      guestFields: defaultCheckinSettings.guestFields.map((entry) => ({
        ...entry,
        required: false,
      })),
    },
  );
  const popup = await openPopup(page);

  await expect(popup.getByText("1 of 1 guests registered")).toBeVisible();
  await expect(popup.getByText("Every guest’s details are complete")).toBeVisible();
  await expect(popup.getByText("Nothing to pay")).toBeVisible();
  await expect(popup.getByText("Bank Transfer · paid in full")).toBeVisible();
  await expect(popup.getByText("Special request")).toHaveCount(0);
  await assertHealthy();
});

test("still opens when the registrations can't be read", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [/\/guest-registrations$/],
  });
  await mockArrival(page, arrival);
  await page.route(`${base}/guest-registrations`, (route) =>
    route.fulfill({ status: 404, json: { code: "not_found" } }),
  );
  const popup = await openPopup(page);

  await expect(popup.getByText("Couldn’t load the guest registrations.")).toBeVisible();
  await expect(popup.getByText(/^€600(\.00)? due$/)).toBeVisible();
  await expect(popup.getByRole("link", { name: "Start check-in" })).toBeVisible();
  await assertHealthy();
});
