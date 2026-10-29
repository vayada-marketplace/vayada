import type { Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  PMS_WEB_ROOM_TYPE_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
  pmsWebRoomType,
} from "./pmsWebMocks";
import { checkinSettingsResponse } from "./checkinSettingsMocks";

// VAY-2373: a two-room arrival for the 4-step check-in, as on the approved Paper boards: room 104
// leaves two nights earlier, Ada is registered, Grace has only her date of birth, a special request.
const property = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}`;
const base = `${property}/reservations/${PMS_WEB_RESERVATION_ID}`;
const DOUBLE = "room_type_double";
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
const assignment = (
  roomNumber: string,
  roomTypeId: string,
  position: number,
  checkOut: string,
) => ({
  ...pmsWebReservation.assignments[0]!,
  assignmentId: `assignment_${position}`,
  roomTypeId,
  roomId: `room_${roomNumber}`,
  roomNumber,
  position,
  channel: "booking.com",
  stay: { checkIn: "2026-08-15", checkOut, adults: 2, children: 0 },
});
// Four adults in two rooms; room 104 leaves two nights earlier; a special request.
const arrival = (room1 = "104") => ({
  ...pmsWebReservation,
  source: "channel",
  stay: { checkIn: "2026-08-15", checkOut: "2026-08-19", adults: 4, children: 0 },
  primaryGuest: {
    ...pmsWebReservation.primaryGuest,
    specialRequests: "We arrive late, around 11 pm. Could you leave the keys at the bar?",
  },
  assignments: [
    assignment(room1, room1 === "102" ? PMS_WEB_ROOM_TYPE_ID : DOUBLE, 1, "2026-08-17"),
    assignment("101", PMS_WEB_ROOM_TYPE_ID, 2, "2026-08-19"),
  ],
  pricing: {
    totalAmount: { amountDecimal: "600.00", currency: "EUR" },
    balanceAmount: { amountDecimal: "600.00", currency: "EUR" },
  },
  payment: { method: "pay_at_property", expectedMethod: "pay_at_property", status: "unpaid" },
  additionalGuestCount: 1,
});
const room = (roomNumber: string, roomTypeId: string, status = "available") => ({
  roomId: `room_${roomNumber}`,
  roomTypeId,
  roomNumber,
  floor: "1",
  status,
  sortOrder: Number(roomNumber),
  metadata: {},
});
const list = (items: unknown[]) => ({
  contractVersion: "pms-operations.v1",
  propertyId: PMS_WEB_PROPERTY_ID,
  items,
  sourceFreshness: {},
});
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

/** The desk add-on catalog: breakfast per guest per night, a scooter a day, a late check-out. */
export const checkinAddons = [
  {
    addonItemId: "a1000000-0000-4000-8000-000000000001",
    name: "Breakfast",
    pricingModel: "per_guest_night",
    price: "8.00",
  },
  {
    addonItemId: "a1000000-0000-4000-8000-000000000002",
    name: "Scooter rental",
    pricingModel: "per_night",
    price: "10.00",
  },
  {
    addonItemId: "a1000000-0000-4000-8000-000000000003",
    name: "Late check-out",
    pricingModel: "per_stay",
    price: "20.00",
  },
].map((addon) => ({ ...addon, description: "", currency: "EUR", category: "" }));

export async function mockCheckinFlow(
  page: Page,
  settings: Record<string, unknown> = {},
  reservation: Record<string, unknown> = {},
) {
  const writes = {
    guests: [] as Record<string, unknown>[],
    registrations: [] as Array<{ guestId: string; body: Record<string, unknown> }>,
    moves: [] as Record<string, unknown>[],
    charges: [] as Record<string, unknown>[],
    chargePaid: [] as string[],
    chargeWaived: [] as string[],
    markPaid: [] as Record<string, unknown>[],
    checkIn: [] as Record<string, unknown>[],
  };
  let current: Record<string, unknown> = { ...arrival(), ...reservation };
  await page.clock.install({ time: new Date("2026-08-15T12:00:00Z") });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`${property}/check-in-settings`, (route) =>
    route.fulfill({ json: checkinSettingsResponse(settings) }),
  );
  await page.route(`${base}/notes`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  for (const path of ["check-in-checklist", "check-out-inspection"])
    await page.route(`${property}/${path}`, (route) =>
      route.fulfill({ json: { template: { steps: [], updatedAt: null, updatedByUserId: null } } }),
    );
  await page.route(`${base}/additional-guests**`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [grace] } });
    const body = (route.request().postDataJSON() as { guest: Record<string, unknown> }).guest;
    writes.guests.push(body);
    // A new guest is listed as guest_new; an update (only the changed fields) merges into Grace.
    const guest = {
      ...(route.request().method() === "PATCH"
        ? grace
        : { ...grace, guestId: "guest_new", email: null, phone: null, countryCode: null }),
      ...body,
    };
    return route.fulfill({
      json: {
        additionalGuest: { ...guest, displayName: `${guest.firstName} ${guest.lastName}` },
      },
    });
  });
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
  // Ada's guest record, through which her name and contact are edited (VAY-2420).
  await page.route(`${base}/guest-profiles`, (route) =>
    route.fulfill({
      json: {
        guestBookingId: PMS_WEB_RESERVATION_ID,
        guests: [
          {
            bookingGuestId: "guest_ada",
            role: "booker",
            firstName: "Ada",
            lastName: "Lovelace",
            guestProfileId: "f6855a00-0000-4000-8000-000000000002",
            reservations: 1,
            notes: [],
          },
        ],
      },
    }),
  );
  await page.route(`${base}/guest-registrations/*`, (route) => {
    const guestId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.registrations.push({ guestId, body });
    return route.fulfill({
      json: {
        guestId,
        role: guestId === "guest_ada" ? "booker" : "additional_guest",
        ...body,
        filledFields: Object.keys(body).filter((key) => body[key] !== null),
        updatedAt: "2026-08-15T12:05:00Z",
      },
    });
  });
  await page.route(`${base}/assignments`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.moves.push(body);
    current = { ...arrival("102"), ...reservation };
    return route.fulfill({ json: { accepted: true } });
  });
  await page.route(`${property}/manual-bookings/addons`, (route) =>
    route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: checkinAddons } }),
  );
  // Desk charges (D3): created, paid with the balance, waived when removed.
  await page.route(`${base}/checkout-charges**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [] } });
    const chargeId = path.split("/").at(-2)!;
    const status = path.endsWith("/paid") ? "paid" : path.endsWith("/waive") ? "waived" : "pending";
    if (status === "paid") writes.chargePaid.push(chargeId);
    if (status === "waived") writes.chargeWaived.push(chargeId);
    const body =
      status === "pending" ? (route.request().postDataJSON() as Record<string, unknown>) : {};
    if (status === "pending") writes.charges.push(body);
    const amount = { amountDecimal: String(body.amountDecimal ?? "0.00"), currency: "EUR" };
    return route.fulfill({
      json: {
        charge: {
          chargeId:
            status === "pending"
              ? `c1000000-0000-4000-8000-00000000000${writes.charges.length}`
              : chargeId,
          label: body.label ?? "",
          amount,
          originalAmount: amount,
          status,
          createdAt: "2026-08-15T12:10:00.000Z",
          settledAt: status === "paid" ? "2026-08-15T12:11:00.000Z" : null,
          waivedAt: status === "waived" ? "2026-08-15T12:11:00.000Z" : null,
        },
      },
    });
  });
  // Mark-paid records how the desk took the money (D2); the balance is then settled.
  await page.route(`${base}/mark-paid`, (route) => {
    writes.markPaid.push(route.request().postDataJSON() as Record<string, unknown>);
    current = {
      ...current,
      pricing: {
        totalAmount: (current.pricing as { totalAmount: unknown }).totalAmount,
        balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
      },
      payment: { ...(current.payment as Record<string, unknown>), status: "paid" },
    };
    return route.fulfill({ json: { reservation: current } });
  });
  await page.route(`${base}/check-in`, (route) => {
    writes.checkIn.push(route.request().postDataJSON() as Record<string, unknown>);
    current = { ...current, status: "checked_in" };
    return route.fulfill({ json: {} });
  });
  await page.route(base, (route) => route.fulfill({ json: { item: current } }));
  // The move picker's calendar read: two room types, one room taken, one blocked, one out of service.
  await page.route(`${property}/room-types*`, (route) =>
    route.fulfill({
      json: list([
        { ...pmsWebRoomType, roomTypeId: DOUBLE, name: "Double Room with balcony" },
        pmsWebRoomType,
      ]),
    }),
  );
  await page.route(`${property}/rooms*`, (route) =>
    route.fulfill({
      json: {
        ...list([
          room("101", PMS_WEB_ROOM_TYPE_ID),
          room("102", PMS_WEB_ROOM_TYPE_ID),
          room("103", PMS_WEB_ROOM_TYPE_ID, "out_of_service"),
          room("104", DOUBLE),
          room("105", DOUBLE),
          room("106", DOUBLE),
        ]),
        orderVersion: "1",
      },
    }),
  );
  await page.route(`${property}/reservations?*`, (route) =>
    route.fulfill({
      json: {
        ...list([
          current,
          {
            ...pmsWebReservation,
            guestBookingId: "reservation_other",
            bookingReference: "VAY-OTHER",
            stay: { checkIn: "2026-08-14", checkOut: "2026-08-16", adults: 2, children: 0 },
            assignments: [
              {
                ...assignment("106", DOUBLE, 1, "2026-08-16"),
                assignmentId: "assignment_other",
                stay: { checkIn: "2026-08-14", checkOut: "2026-08-16", adults: 2, children: 0 },
              },
            ],
          },
        ]),
        pagination: { total: 2, limit: 500, offset: 0 },
      },
    }),
  );
  return writes;
}
