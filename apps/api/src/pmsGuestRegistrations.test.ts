import {
  createFakeVerifier,
  staffAccessPermissionKeys,
  staffRoleDefaultPermissions,
  type IdentityRepository,
  type PermissionKey,
  type ResourceRelationship,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  PmsGuestRegistration,
  PmsGuestRegistrationRepository,
  PmsGuestRegistrationSave,
  PmsGuestRegistrationsResponse,
} from "./routes/pmsGuestRegistrations.js";

const propertyId = "23730000-0000-4000-8000-000000000001";
const bookingId = "23730000-0000-4000-8000-000000000002";
const bookerId = "23730000-0000-4000-8000-000000000003";
const guestId = "23730000-0000-4000-8000-000000000004";
const assignmentId = "23730000-0000-4000-8000-000000000005";
const organizationId = "11111111-1111-1111-1111-111111111111";
const actorUserId = "22222222-2222-2222-2222-222222222222";
const url = `/api/pms/properties/${propertyId}/reservations/${bookingId}/guest-registrations`;
const headers = { authorization: "Bearer valid-token" };
const FULL: PermissionKey[] = [
  "pms.reservation.read",
  "pms.reservation.update",
  "pms.guest_contact.read",
];
// VAY-2498: the account admin's grants hold the old broad keys and every staff key (0002, 0109).
const OWNER: PermissionKey[] = [
  "pms.operations.read",
  "pms.operations.manage",
  "pms.finance.manage",
  ...staffAccessPermissionKeys,
];

const grace: PmsGuestRegistration = {
  guestId,
  role: "additional_guest",
  assignmentId,
  dateOfBirth: "1986-12-09",
  documentType: "passport",
  documentNumber: "C01X00T47",
  gender: null,
  staffNotes: "Feather allergy",
  filledFields: ["assignmentId", "dateOfBirth", "documentType", "documentNumber", "staffNotes"],
  updatedAt: "2026-10-26T12:00:00.000Z",
};
const booker: PmsGuestRegistration = {
  guestId: bookerId,
  role: "booker",
  assignmentId: null,
  dateOfBirth: null,
  documentType: null,
  documentNumber: null,
  gender: null,
  staffNotes: null,
  filledFields: [],
  updatedAt: null,
};

function createRepository(guests: PmsGuestRegistration[] | null = [booker, grace]) {
  const saves: PmsGuestRegistrationSave[] = [];
  const repository: PmsGuestRegistrationRepository & { saves: typeof saves } = {
    saves,
    async list(id, reservationId) {
      expect([id, reservationId]).toEqual([propertyId, bookingId]);
      return guests;
    },
    async save(command) {
      saves.push(command);
      if (command.guestId !== guestId) return { ok: false, code: "guest_not_found" };
      if (command.fields.assignmentId && command.fields.assignmentId !== assignmentId)
        return { ok: false, code: "assignment_not_found" };
      return { ok: true, registration: { ...grace, ...command.fields } };
    },
  };
  return repository;
}

function buildAuthenticatedApp(
  options: {
    repository?: PmsGuestRegistrationRepository;
    permissions?: PermissionKey[];
    relationship?: ResourceRelationship;
    roleKey?: string;
  } = {},
) {
  const roleKey = options.roleKey ?? "hotel_owner";
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "desk@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey,
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: [roleKey],
      };
    },
    async findLinkedResources() {
      const relationship = options.relationship ?? "front_desk";
      return [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
      ];
    },
  };
  return buildApp({
    logger: false,
    pmsGuestRegistrationRepository: options.repository ?? createRepository(),
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid-token",
            {
              workosUserId: "workos-user-1",
              workosOrgId: "workos-org-1",
              sessionId: "session-1",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? FULL;
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "pms",
              key: "property-management",
              status: "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ];
        },
      },
    },
  });
}

const body = {
  assignmentId,
  dateOfBirth: "1986-12-09",
  documentType: "passport",
  documentNumber: "  C01X00T47 ",
  gender: null,
  staffNotes: "",
};

describe("PMS guest registration routes (VAY-2373)", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lists every guest of the booking with its registration for front desk staff", async () => {
    app = buildAuthenticatedApp();
    const response = await app.inject({ method: "GET", url, headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json<PmsGuestRegistrationsResponse>()).toEqual({
      guestBookingId: bookingId,
      canReadIdentity: true,
      guests: [booker, grace],
    });
  });

  it("hides the ID fields, but not which ones are filled, from staff without guest contact access", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.reservation.read", "pms.reservation.update"],
    });
    const response = await app.inject({ method: "GET", url, headers });

    expect(response.statusCode).toBe(200);
    const { canReadIdentity, guests } = response.json<PmsGuestRegistrationsResponse>();
    expect(canReadIdentity).toBe(false);
    expect(guests[1]).toEqual({
      ...grace,
      dateOfBirth: null,
      documentType: null,
      documentNumber: null,
      gender: null,
    });
    expect(guests[1]!.filledFields).toContain("documentNumber");

    // Saving replaces every field, so a reader who can't see them can't write them either.
    const write = await app.inject({
      method: "PUT",
      url: `${url}/${guestId}`,
      headers,
      payload: body,
    });
    expect(write.statusCode).toBe(403);
  });

  it("answers 404 for a booking of another property and refuses readers without PMS access", async () => {
    app = buildAuthenticatedApp({ repository: createRepository(null) });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
    await app.close();

    app = buildAuthenticatedApp({ permissions: ["pms.finance.read"] });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });

  // VAY-2498: the check-in registration form is daily work for staff with "Reservations: modify".
  it.each([
    ["the account admin", "hotel_owner", OWNER, 200, 200],
    ["front desk", "front_desk", [...staffRoleDefaultPermissions.front_desk], 200, 200],
    [
      "an agency manager",
      "hotel_manager",
      [...staffRoleDefaultPermissions.hotel_manager],
      200,
      200,
    ],
    ["housekeeping", "housekeeping", [...staffRoleDefaultPermissions.housekeeping], 403, 403],
    [
      "front desk without modify",
      "front_desk",
      staffRoleDefaultPermissions.front_desk.filter((key) => key !== "pms.reservation.update"),
      200,
      403,
    ],
  ] as [string, string, PermissionKey[], number, number][])(
    "lets %s read and save the registration form: %s",
    async (_name, roleKey, permissions, readStatus, saveStatus) => {
      const repository = createRepository();
      app = buildAuthenticatedApp({ repository, permissions, roleKey });
      const read = await app.inject({ method: "GET", url, headers });
      const save = await app.inject({
        method: "PUT",
        url: `${url}/${guestId}`,
        headers,
        payload: body,
      });
      expect([read.statusCode, save.statusCode]).toEqual([readStatus, saveStatus]);
      expect(repository.saves).toHaveLength(saveStatus === 200 ? 1 : 0);
    },
  );

  it("saves a whole registration, trimmed, with the actor for the audit event", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });
    const response = await app.inject({
      method: "PUT",
      url: `${url}/${guestId}`,
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(repository.saves).toEqual([
      {
        propertyId,
        guestBookingId: bookingId,
        guestId,
        fields: {
          assignmentId,
          dateOfBirth: "1986-12-09",
          documentType: "passport",
          documentNumber: "C01X00T47",
          gender: null,
          staffNotes: null,
        },
        audit: expect.objectContaining({ actorUserId, organizationId }),
      },
    ]);
    expect(response.json()).toMatchObject({
      guestId,
      documentNumber: "C01X00T47",
      staffNotes: null,
    });
  });

  it("refuses partial, unknown and invalid fields before touching the repository", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });
    const put = (payload: unknown) =>
      app!.inject({ method: "PUT", url: `${url}/${guestId}`, headers, payload: payload as object });
    const partial: Record<string, unknown> = { ...body };
    delete partial.staffNotes;

    for (const payload of [
      partial,
      { ...body, passportNumber: "X" },
      { ...body, dateOfBirth: "2999-01-01" },
      { ...body, dateOfBirth: "1986-02-30" },
      { ...body, documentType: "visa" },
      { ...body, gender: "unknown" },
      { ...body, documentNumber: "X".repeat(65) },
      { ...body, assignmentId: "room-1" },
    ]) {
      const response = await put(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(repository.saves).toEqual([]);
  });

  it("answers 404 for a guest of another booking and 400 for a room outside the booking", async () => {
    app = buildAuthenticatedApp();
    const otherGuest = await app.inject({
      method: "PUT",
      url: `${url}/23730000-0000-4000-8000-0000000000ff`,
      headers,
      payload: body,
    });
    expect(otherGuest.statusCode).toBe(404);

    const otherRoom = await app.inject({
      method: "PUT",
      url: `${url}/${guestId}`,
      headers,
      payload: { ...body, assignmentId: "23730000-0000-4000-8000-0000000000aa" },
    });
    expect(otherRoom.statusCode).toBe(400);
  });
});
