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

export async function mockCheckinFlow(page: Page, settings: Record<string, unknown> = {}) {
  const writes = {
    guests: [] as Record<string, unknown>[],
    registrations: [] as Array<{ guestId: string; body: Record<string, unknown> }>,
    moves: [] as Record<string, unknown>[],
  };
  let current = arrival();
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
    return route.fulfill({
      json: {
        additionalGuest: {
          ...grace,
          guestId: "guest_new",
          displayName: `${body.firstName} ${body.lastName}`,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email ?? null,
          phone: body.phone ?? null,
          countryCode: body.countryCode ?? null,
        },
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
  await page.route(`${base}/guest-registrations/*`, (route) => {
    const guestId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.registrations.push({ guestId, body });
    return route.fulfill({
      json: {
        guestId,
        role: "additional_guest",
        ...body,
        filledFields: Object.keys(body).filter((key) => body[key] !== null),
        updatedAt: "2026-08-15T12:05:00Z",
      },
    });
  });
  await page.route(`${base}/assignments`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.moves.push(body);
    current = arrival("102");
    return route.fulfill({ json: { accepted: true } });
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
