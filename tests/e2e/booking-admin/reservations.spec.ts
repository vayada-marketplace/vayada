import { expect, test } from "@playwright/test";
import type { BookingReservationList } from "../../../apps/booking-admin/services/api/bookingReservationsClient";
import { watchPageHealth } from "../support/pageHealth";

// VAY-706: cutover smoke for the booking-admin reservations surface.
//
// This spec drives the screen and asserts it issues a GET to the real contract
// pathname `/api/booking/hotels/:hotelId/reservations` (the route VAY-705 wired
// into apps/api) before rendering the product list shape. The contract response
// is fulfilled with a fixture so the test is hermetic: it proves the screen
// targets the real contract route — not a fabricated mock endpoint — but it does
// not exercise a live apps/api. End-to-end verification against a running
// backend + read model is a separate manual step (see the cutover runbook).
//
// Why this is gated behind E2E_BOOKING_ADMIN_PROD:
// The booking-admin `(app)` routes sit behind a client-side auth gate
// (`app/(app)/layout.tsx`) that renders nothing until React hydrates and the
// effect confirms the session. The shared e2e harness serves booking-admin via
// `next dev`, whose authenticated shell does not become interactive under the
// Playwright/Chromium run here (HMR socket is unavailable), so the existing
// booking-admin smoke only asserts static `/login` markup. A production build
// (`next build` + `next start`) hydrates the shell correctly. Run this smoke
// against a production booking-admin server — see
// engineering/booking-reservations-cutover-runbook.md § Verification:
//
//   cd apps/booking-admin && npm run build && PORT=3013 npx next start -p 3013
//   E2E_BOOKING_ADMIN_PROD=1 E2E_BOOKING_ADMIN_BASE_URL=http://127.0.0.1:3013 \
//     npm run e2e:booking-admin

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

const HOTEL_ID = "booking_hotel_alpenrose";
const RESERVATIONS_CONTRACT_PATH = `/api/booking/hotels/${HOTEL_ID}/reservations`;

const reservationListFixture: BookingReservationList = {
  bookings: [
    {
      id: "reservation_1",
      bookingReference: "VAY-2026-0001",
      roomTypeId: "room_type_suite",
      roomName: "Suite",
      roomMaxOccupancy: 2,
      totalRoomCapacity: 2,
      guestFirstName: "Ada",
      guestLastName: "Lovelace",
      guestEmail: "ada@example.com",
      guestPhone: "+15555550123",
      guestCountry: "GB",
      guestGender: "",
      guestDateOfBirth: null,
      guestPassportNumber: "",
      specialRequests: "",
      estimatedArrivalTime: null,
      numberOfGuests: 2,
      checkIn: "2026-07-10",
      checkOut: "2026-07-12",
      nights: 2,
      adults: 2,
      children: 0,
      nightlyRate: 120.5,
      numberOfRooms: 1,
      totalAmount: 241,
      currency: "EUR",
      status: "confirmed",
      roomId: null,
      roomNumber: null,
      assignedRooms: [],
      channel: "direct",
      paymentMethod: "card",
      paymentStatus: "captured",
      depositRequired: false,
      depositPercentage: null,
      depositAmount: 0,
      balanceAmount: 241,
      checkInPendingFlags: [],
      checkedInAt: null,
      checkedOutAt: null,
      hostResponseDeadline: null,
      platformFeeAmount: null,
      affiliateCommissionAmount: null,
      propertyPayoutAmount: null,
      addonIds: [],
      addonNames: [],
      addonTotal: 0,
      addonQuantities: {},
      addonDates: {},
      guestWithdrawn: false,
      promoCode: null,
      promoDiscount: 0,
      lastMinuteDiscountPercent: 0,
      lastMinuteDiscountAmount: 0,
      createdAt: "2026-06-01T12:00:00.000Z",
      updatedAt: "2026-06-02T12:00:00.000Z",
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

test.describe("booking-admin reservations cutover", () => {
  test("loads the reservations screen from the real TypeScript contract path", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build; the dev e2e server does not hydrate the authenticated shell. See engineering/booking-reservations-cutover-runbook.md § Verification.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

    await page.addInitScript((hotelId) => {
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      window.localStorage.setItem("access_token", "e2e-booking-admin-token");
      window.localStorage.setItem("token_expires_at", String(oneHourFromNow));
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("userType", "hotel");
      window.localStorage.setItem("isSuperAdmin", "false");
      window.localStorage.setItem("selectedHotelId", hotelId);
      window.localStorage.setItem(
        "user",
        JSON.stringify({ id: "user_1", email: "owner@example.com", type: "hotel" }),
      );
    }, HOTEL_ID);

    // Keep the admin shell quiet so the smoke isolates the reservations surface.
    // Register the broad fallback first; Playwright lets later, more specific
    // routes win, so the explicit stubs below take precedence over this one.
    await page.route("**/admin/**", (route) => route.fulfill({ json: {} }));
    await page.route("**/admin/module-activations", (route) =>
      route.fulfill({ json: { activations: [] } }),
    );
    await page.route("**/admin/hotels", (route) =>
      route.fulfill({ json: [{ id: HOTEL_ID, name: "Alpenrose", slug: "hotel-alpenrose" }] }),
    );
    await page.route("**/admin/superadmin/hotels", (route) => route.fulfill({ json: [] }));

    const contractRequests: string[] = [];
    await page.route(`**${RESERVATIONS_CONTRACT_PATH}*`, async (route) => {
      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: reservationListFixture });
    });

    await page.goto("/reservations");

    await expect(page.getByRole("heading", { name: "Reservations", level: 1 })).toBeVisible();
    await expect(page.getByText("VAY-2026-0001")).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toBeVisible();

    // The data fetch must hit the real contract path served by apps/api, not a
    // fabricated mock endpoint.
    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(RESERVATIONS_CONTRACT_PATH);

    await assertHealthy();
  });
});
