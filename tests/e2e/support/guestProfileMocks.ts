import type { Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "./pmsWebMocks";

// VAY-2420: Timo Schreyer with two stays (Munich and Galle), and a second record of him, for search,
// the Guests list and the guest profile.
const GUESTS = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guests`;
export const TIMO = "f6855a00-0000-4000-8000-0000000000a1";
export const TIMO_TWIN = "f6855a00-0000-4000-8000-0000000000a2";
const GALLE = "f6853000-0000-4000-8000-000000000099";

const timo = {
  guestProfileId: TIMO,
  firstName: "Timo",
  lastName: "Schreyer",
  email: "t.schreyer@example.test",
  phone: "+49 157 35490950",
  reservations: 2,
  lastCheckIn: "2026-08-15",
};
const twin = {
  ...timo,
  guestProfileId: TIMO_TWIN,
  email: null,
  phone: "+49 157 35490950",
  reservations: 1,
  lastCheckIn: "2025-12-01",
};
const stay = (overrides: Record<string, unknown> = {}) => ({
  bookingGuestId: "guest_timo_munich",
  guestBookingId: PMS_WEB_RESERVATION_ID,
  propertyId: PMS_WEB_PROPERTY_ID,
  propertyName: "Alpenrose Munich",
  bookingReference: "PMS-F38ED4CDB838",
  checkIn: "2026-08-15",
  checkOut: "2026-08-18",
  adults: 1,
  children: 0,
  rooms: ["Alpine Suite"],
  status: "confirmed",
  channel: "direct",
  directSource: "call",
  role: "booker",
  totalAmount: "300.00",
  currency: "EUR",
  ...overrides,
});
const profile = (overrides: Record<string, unknown> = {}) => ({
  ...timo,
  fields: {
    firstName: "Timo",
    lastName: "Schreyer",
    email: timo.email,
    phone: timo.phone,
    countryCode: null,
    dateOfBirth: null,
    documentType: null,
    documentNumber: null,
  },
  canReadContact: true,
  contactHidden: false,
  nextArrival: "2026-08-15",
  guestSince: "2025-03-02T10:00:00.000Z",
  stays: [
    stay(),
    stay({
      bookingGuestId: "guest_timo_galle",
      guestBookingId: "guest_booking_galle",
      propertyId: GALLE,
      propertyName: "71 Pedlar St Galle Fort",
      bookingReference: "VAY-DCFC01D5073548DE",
      checkIn: "2025-03-10",
      checkOut: "2025-03-12",
      adults: 2,
      rooms: ["Garden Room"],
      status: "completed",
      directSource: "booking_engine",
      totalAmount: "180.00",
    }),
  ],
  notes: [],
  ...overrides,
});

export async function mockGuests(page: Page, overrides: Record<string, unknown> = {}) {
  const writes = { edits: [] as unknown[], merges: [] as unknown[], separations: [] as unknown[] };
  let current = profile(overrides);
  await page.clock.install({ time: new Date("2026-08-15T12:00:00Z") });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`${GUESTS}?*`, (route) => {
    const search = new URL(route.request().url()).searchParams.get("search") ?? "";
    return route.fulfill({
      json: { guests: search.toLowerCase().includes("nobody") ? [] : [timo, twin] },
    });
  });
  await page.route(`${GUESTS}/${TIMO}`, (route) => {
    if (route.request().method() === "PATCH") {
      const edit = route.request().postDataJSON() as Record<string, unknown>;
      writes.edits.push(edit);
      current = profile({
        lastName: edit.lastName ?? current.lastName,
        phone: edit.phone === undefined ? current.phone : edit.phone,
        fields: { ...current.fields, ...edit },
      });
    }
    return route.fulfill({ json: current });
  });
  await page.route(`${GUESTS}/${TIMO}/merge`, (route) => {
    writes.merges.push(route.request().postDataJSON());
    current = profile({
      reservations: 3,
      stays: [...current.stays, stay({ bookingGuestId: "x" })],
    });
    return route.fulfill({ json: current });
  });
  await page.route(`${GUESTS}/${TIMO}/separate`, (route) => {
    writes.separations.push(route.request().postDataJSON());
    current = profile({ reservations: 1, stays: [stay()] });
    return route.fulfill({ status: 201, json: { guestProfileId: TIMO_TWIN } });
  });
  return writes;
}
