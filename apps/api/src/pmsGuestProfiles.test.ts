import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  PmsGuestProfile,
  PmsGuestProfileRepository,
  PmsGuestProfileScope,
} from "./routes/pmsGuestProfiles.js";

const propertyId = "24200000-0000-4000-8000-000000000001";
const otherPropertyId = "24200000-0000-4000-8000-000000000002";
const guestProfileId = "24200000-0000-4000-8000-000000000003";
const bookingGuestId = "24200000-0000-4000-8000-000000000004";
const guestBookingId = "24200000-0000-4000-8000-000000000005";
const organizationId = "11111111-1111-1111-1111-111111111111";
const base = `/api/pms/properties/${propertyId}/guests`;
const headers = { authorization: "Bearer valid-token" };
const FULL: PermissionKey[] = [
  "pms.reservation.read",
  "pms.operations.manage",
  "pms.guest_contact.read",
];

const profile: PmsGuestProfile = {
  guestProfileId,
  firstName: "Timo",
  lastName: "Schreyer",
  email: "timo@example.test",
  phone: null,
  reservations: 1,
  lastCheckIn: "2027-08-15",
  fields: {
    firstName: "Timo",
    lastName: "Schreyer",
    email: "timo@example.test",
    phone: null,
    countryCode: "DE",
    dateOfBirth: null,
    documentType: null,
    documentNumber: null,
  },
  canReadContact: true,
  nextArrival: "2027-08-15",
  guestSince: "2026-10-01T00:00:00.000Z",
  stays: [],
  notes: [],
};

function createRepository() {
  const calls: { method: string; scope: PmsGuestProfileScope; args: unknown[] }[] = [];
  const record =
    <T>(method: string, result: T) =>
    async (scope: PmsGuestProfileScope, ...args: unknown[]) => {
      calls.push({ method, scope, args });
      return result;
    };
  const repository: PmsGuestProfileRepository = {
    search: record("search", []),
    get: record("get", profile),
    edit: async (scope, id, edit, stay, audit) => {
      calls.push({ method: "edit", scope, args: [id, edit, stay, audit] });
      if (edit.email === "hidden@example.test") return "contact_hidden";
      return stay === guestBookingId ? "stay_not_found" : profile;
    },
    addNote: record("addNote", {
      noteId: bookingGuestId,
      body: "Feather allergy",
      propertyId,
      createdByUserId: null,
      createdAt: "2026-10-29T00:00:00.000Z",
    }),
    deleteNote: record("deleteNote", false),
    separate: record("separate", "only_stay" as const),
    merge: record("merge", "not_found" as const),
    reservationProfiles: record("reservationProfiles", null),
  };
  return { repository, calls };
}

function buildAuthenticatedApp(repository: PmsGuestProfileRepository, permissions = FULL) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return {
        userId: "22222222-2222-2222-2222-222222222222",
        email: "desk@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return [propertyId, otherPropertyId].flatMap((resourceId) => [
        {
          product: "pms" as const,
          resourceType: "pms_property" as const,
          resourceId,
          relationship: "front_desk" as const,
          status: "active" as const,
        },
        {
          product: "hotel_catalog" as const,
          resourceType: "property" as const,
          resourceId,
          relationship: "front_desk" as const,
          status: "active" as const,
        },
      ]);
    },
  };
  return buildApp({
    logger: false,
    pmsGuestProfileRepository: repository,
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
          return permissions;
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

describe("PMS guest profile routes (VAY-2420)", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("searches the account's guests at every property the reader may open", async () => {
    const { repository, calls } = createRepository();
    app = buildAuthenticatedApp(repository);
    const response = await app.inject({
      method: "GET",
      url: `${base}?search=%20Timo%20&limit=5`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(calls).toEqual([
      {
        method: "search",
        scope: {
          propertyId,
          propertyIds: [propertyId, otherPropertyId],
          canReadContact: true,
        },
        args: [{ search: "Timo", limit: 5 }],
      },
    ]);
  });

  it("needs reservation access to read and operations access to write", async () => {
    const { repository, calls } = createRepository();
    app = buildAuthenticatedApp(repository, ["pms.operations.manage"]);
    expect((await app.inject({ method: "GET", url: base, headers })).statusCode).toBe(403);
    await app.close();

    app = buildAuthenticatedApp(repository, ["pms.reservation.read"]);
    const patch = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { firstName: "Tim" },
    });
    expect(patch.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses contact and ID fields from staff without guest contact access", async () => {
    const { repository, calls } = createRepository();
    app = buildAuthenticatedApp(repository, ["pms.reservation.read", "pms.operations.manage"]);
    const response = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { documentNumber: "C01X00T47" },
    });
    expect(response.statusCode).toBe(403);

    const names = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { lastName: " Schreyer " },
    });
    expect(names.statusCode).toBe(200);
    expect(calls.map(({ method, args }) => [method, args[1]])).toEqual([
      ["edit", { lastName: "Schreyer" }],
    ]);
  });

  it("passes an explicit clear and validates every field", async () => {
    const { repository, calls } = createRepository();
    app = buildAuthenticatedApp(repository);
    const clear = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { email: null, phone: "  ", countryCode: " de ", bookingGuestId },
    });
    expect(clear.statusCode).toBe(200);
    expect(calls[0]?.args.slice(1, 3)).toEqual([
      { email: null, phone: null, countryCode: "DE" },
      bookingGuestId,
    ]);

    for (const [payload, message] of [
      [{}, "Send at least one field to change."],
      [{ gender: "female" }, "Unknown field: gender."],
      [{ firstName: " " }, "firstName must be text of 1 to 200 characters."],
      [{ email: "not an email" }, "email must be an email address or null."],
      [{ countryCode: "Atlantis" }, "countryCode must be a supported nationality or null."],
      [{ dateOfBirth: "2999-01-01" }, "dateOfBirth must be a past date (YYYY-MM-DD) or null."],
      [{ documentType: "visa" }, expect.stringContaining("documentType must be one of")],
    ] as const) {
      const response = await app.inject({
        method: "PATCH",
        url: `${base}/${guestProfileId}`,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_request", message });
    }

    const wrongStay = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { firstName: "Tim", bookingGuestId: guestBookingId },
    });
    expect(wrongStay.statusCode).toBe(400);

    // Contact the property may not see yet ("Hidden until you accept") can't be replaced.
    const hidden = await app.inject({
      method: "PATCH",
      url: `${base}/${guestProfileId}`,
      headers,
      payload: { email: "hidden@example.test", bookingGuestId },
    });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json()).toEqual({ code: "guest_contact_hidden" });
  });

  it("adds notes, and answers for missing notes, last stays and self-merges", async () => {
    const { repository } = createRepository();
    app = buildAuthenticatedApp(repository);
    const note = await app.inject({
      method: "POST",
      url: `${base}/${guestProfileId}/notes`,
      headers,
      payload: { body: "  Feather allergy " },
    });
    expect(note.statusCode).toBe(201);
    const empty = await app.inject({
      method: "POST",
      url: `${base}/${guestProfileId}/notes`,
      headers,
      payload: { body: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const deleted = await app.inject({
      method: "DELETE",
      url: `${base}/${guestProfileId}/notes/${bookingGuestId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(404);
    const separate = await app.inject({
      method: "POST",
      url: `${base}/${guestProfileId}/separate`,
      headers,
      payload: { bookingGuestId },
    });
    expect([separate.statusCode, separate.json()]).toEqual([409, { code: "only_stay" }]);
    const merge = await app.inject({
      method: "POST",
      url: `${base}/${guestProfileId}/merge`,
      headers,
      payload: { guestProfileId },
    });
    expect(merge.statusCode).toBe(400);
    const reservation = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${propertyId}/reservations/${guestBookingId}/guest-profiles`,
      headers,
    });
    expect([reservation.statusCode, reservation.json()]).toEqual([
      404,
      { code: "reservation_not_found" },
    ]);
  });
});
