import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { mockCheckinFlow } from "../support/checkinFlowMocks";
import { TIMO, mockGuests, stay } from "../support/guestProfileMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2577: an email or phone a channel booking came without says which channel didn't send it,
// as approved in Paper ("VAY-2577 Not provided by Airbnb / Booking.com", Vayada – Proposals).
// Booking.com and Airbnb no longer send phones (Channex support, 2026-11-24), so a missing phone
// there also says where the host still sees it.
const BOOKING_COM_PHONE = "Not provided by Booking.com – see the Booking.com extranet";
const AIRBNB_PHONE = "Not provided by Airbnb – see the Airbnb app";
const reservationPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;

async function mockReservation(page: Page, channel: string, contact: Record<string, unknown>) {
  const item = {
    ...pmsWebReservation,
    source: channel === "direct" ? "direct_booking" : "channel",
    assignments: [{ ...pmsWebReservation.assignments[0]!, channel }],
    primaryGuest: { ...pmsWebReservation.primaryGuest, ...contact },
  };
  await page.route(reservationPath, (route) => route.fulfill({ json: { item } }));
}

async function openBooking(page: Page, channel: string, contact: Record<string, unknown>) {
  await mockReservation(page, channel, contact);
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
}

test("says which channel sent no email or phone on the booking (VAY-2577)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  for (const path of ["notes", "additional-guests"])
    await page.route(`${reservationPath}/${path}`, (route) =>
      route.fulfill({ json: { items: [] } }),
    );
  await page.route(`${reservationPath}/change-request`, (route) => route.fulfill({ json: null }));
  const main = page.locator("main").first();

  // Airbnb sends a phone but no email.
  await openBooking(page, "airbnb", { email: null, phone: "+49 151 2345 6789" });
  await expect(main.getByText("Not provided by Airbnb", { exact: true })).toHaveCount(1);
  await expect(main.getByText("+49 151 2345 6789", { exact: true })).toBeVisible();

  // Booking.com sends its masked address, and no phone: the host finds it in the extranet.
  await page.unroute(reservationPath);
  await openBooking(page, "booking_com", { email: "lena.h7k2@guest.booking.com", phone: null });
  await expect(main.getByText("lena.h7k2@guest.booking.com", { exact: true })).toBeVisible();
  await expect(main.getByText(BOOKING_COM_PHONE, { exact: true })).toHaveCount(1);
  await expect(main.getByText("Not provided by Booking.com", { exact: true })).toHaveCount(0);

  // An Airbnb booking without either: the email stays plain, the phone points to the Airbnb app.
  await page.unroute(reservationPath);
  await openBooking(page, "airbnb", { email: null, phone: null });
  await expect(main.getByText("Not provided by Airbnb", { exact: true })).toHaveCount(1);
  await expect(main.getByText(AIRBNB_PHONE, { exact: true })).toHaveCount(1);

  // Other channels keep the plain wording for a phone too.
  await page.unroute(reservationPath);
  await openBooking(page, "expedia", { email: "guest@example.com", phone: null });
  await expect(main.getByText("Not provided by Expedia", { exact: true })).toHaveCount(1);
  await expect(main.getByText(/ – see the /)).toHaveCount(0);

  // Contact the property may not see yet stays hidden, not "not provided".
  await page.unroute(reservationPath);
  await openBooking(page, "airbnb", {
    email: "Hidden until you accept",
    phone: "Hidden until you accept",
  });
  await expect(main.getByText("Hidden until you accept", { exact: true })).toHaveCount(2);
  await expect(main.getByText(/^Not provided by/)).toHaveCount(0);

  // A direct booking keeps its own empty state.
  await page.unroute(reservationPath);
  await openBooking(page, "direct", { phone: null });
  await expect(main.getByText(/^Not provided by/)).toHaveCount(0);
  await assertHealthy();
});

test("shows the booker's missing phone as not provided by the channel at check-in (VAY-2577)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(
    page,
    { confirmSpecialRequest: false },
    { primaryGuest: { ...pmsWebReservation.primaryGuest, phone: null } },
  );
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const main = page.locator("main").first();
  await main.getByRole("button", { name: "Confirm arrival" }).click();
  await main.getByRole("button", { name: /^Edit Ada Lovelace/ }).click();
  const form = main.getByRole("form", { name: "Ada Lovelace" });
  const phone = form.getByRole("textbox", { name: /^Phone/ });
  // Said under the field, in full; staff can still type the number the guest gives at the desk.
  await expect(form.getByText(BOOKING_COM_PHONE, { exact: true })).toBeVisible();
  await expect(phone).toHaveValue("");
  await expect(phone).toBeEditable();
  await expect(form.getByRole("textbox", { name: /^Email/ })).toHaveValue("ada@example.com");
  await assertHealthy();
});

test("says so in the booker's locked phone when their guest record can't be reached (VAY-2577)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(
    page,
    { confirmSpecialRequest: false },
    { primaryGuest: { ...pmsWebReservation.primaryGuest, phone: null } },
  );
  // No guest record for the booker: their name and contact show locked, as booked.
  await page.route(`${reservationPath}/guest-profiles`, (route) =>
    route.fulfill({ json: { guestBookingId: PMS_WEB_RESERVATION_ID, guests: [] } }),
  );
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const main = page.locator("main").first();
  await main.getByRole("button", { name: "Confirm arrival" }).click();
  await main.getByRole("button", { name: /^Edit Ada Lovelace/ }).click();
  const form = main.getByRole("form", { name: "Ada Lovelace" });
  await expect(form.getByRole("textbox", { name: /^Phone/ })).not.toBeEditable();
  // The lock line says what the channel didn't send instead of "From the booking".
  await expect(form.getByText(BOOKING_COM_PHONE, { exact: true })).toBeVisible();
  await assertHealthy();
});

const airbnbStay = stay({
  bookingGuestId: "guest_timo_airbnb",
  guestBookingId: "guest_booking_airbnb",
  bookingReference: "CHX-9E3C27A1F6B04D58E2C7",
  channel: "airbnb",
  directSource: null,
});
const noEmail = {
  firstName: "Timo",
  lastName: "Schreyer",
  email: null,
  phone: "+49 157 35490950",
  countryCode: null,
  dateOfBirth: null,
  documentType: null,
  documentNumber: null,
};

test("names the channel on a guest who only booked through it (VAY-2577)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockGuests(page, { email: null, fields: noEmail, stays: [airbnbStay] });
  await page.goto(`/guests/${TIMO}`);
  const data = page.getByRole("region", { name: "Guest data" });
  await expect(data.getByText("Not provided by Airbnb", { exact: true })).toHaveCount(1);
  // Other details keep the plain wording.
  await expect(data.getByText("Not provided", { exact: true })).toHaveCount(4);
  await assertHealthy();
});

test("says where to find the phone on a guest who only booked through Airbnb (VAY-2577)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockGuests(page, {
    email: null,
    phone: null,
    fields: { ...noEmail, phone: null },
    stays: [airbnbStay],
  });
  await page.goto(`/guests/${TIMO}`);
  const data = page.getByRole("region", { name: "Guest data" });
  await expect(data.getByText("Not provided by Airbnb", { exact: true })).toHaveCount(1);
  await expect(data.getByText(AIRBNB_PHONE, { exact: true })).toHaveCount(1);
  await assertHealthy();
});

for (const [who, stays] of [
  ["also booked directly", [airbnbStay, stay()]],
  // A channel sends the booker's contact only; staff entered this guest's.
  ["only came along on a channel booking", [{ ...airbnbStay, role: "additional_guest" }]],
] as const)
  test(`keeps the plain wording on a guest who ${who} (VAY-2577)`, async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockGuests(page, { email: null, fields: noEmail, stays });
    await page.goto(`/guests/${TIMO}`);
    const data = page.getByRole("region", { name: "Guest data" });
    await expect(data.getByText("Not provided", { exact: true })).toHaveCount(5);
    await expect(data.getByText(/^Not provided by/)).toHaveCount(0);
    await assertHealthy();
  });
