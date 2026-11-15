import {
  staffAccessPermissionKeys,
  staffRoleDefaultPermissions,
  type PermissionKey,
  type RequestContext,
} from "@vayada/backend-auth";
import type { BookingGuestPiiPort } from "@vayada/domain-booking";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperationsRoutes,
  type PmsOperationsCommandRepository,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";

// VAY-2498: daily PMS work checks the staff keys; money and setup keep the owner-only keys.
const propertyId = "84980000-0000-4000-8000-000000000001";
const bookingId = "84980000-0000-4000-8000-000000000002";
const organizationId = "84980000-0000-4000-8000-000000000003";
const actorId = "84980000-0000-4000-8000-000000000004";
const itemId = "84980000-0000-4000-8000-000000000005";
const otherPropertyId = "84980000-0000-4000-8000-000000000007";
const reservation = `/properties/${propertyId}/reservations/${bookingId}`;

type Actor = { roleKey: string; permissions: readonly PermissionKey[] };
// The account admin holds the old broad keys and every staff key (0002 and 0109 grants).
const owner: Actor = {
  roleKey: "hotel_owner",
  permissions: [
    "pms.operations.read",
    "pms.operations.manage",
    "pms.finance.manage",
    ...staffAccessPermissionKeys,
  ],
};
const agencyManager: Actor = {
  roleKey: "hotel_manager",
  permissions: staffRoleDefaultPermissions.hotel_manager,
};
const frontDesk: Actor = {
  roleKey: "front_desk",
  permissions: staffRoleDefaultPermissions.front_desk,
};
const housekeeping: Actor = {
  roleKey: "housekeeping",
  permissions: staffRoleDefaultPermissions.housekeeping,
};
const without = (actor: Actor, key: PermissionKey): Actor => ({
  ...actor,
  permissions: actor.permissions.filter((permission) => permission !== key),
});

type Route = { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string };
const dailyWork: (Route & { key: PermissionKey })[] = [
  { method: "POST", url: `${reservation}/check-in`, key: "pms.reservation.update" },
  { method: "POST", url: `${reservation}/check-out`, key: "pms.reservation.update" },
  { method: "PATCH", url: `${reservation}/status`, key: "pms.reservation.update" },
  { method: "PATCH", url: `${reservation}/assignments`, key: "pms.reservation.update" },
  { method: "POST", url: `${reservation}/accept`, key: "pms.reservation.update" },
  { method: "POST", url: `${reservation}/correct-stays`, key: "pms.reservation.update" },
  {
    method: "PATCH",
    url: `${reservation}/primary-guest/nationality`,
    key: "pms.reservation.update",
  },
  { method: "GET", url: `${reservation}/additional-guests`, key: "pms.reservation.read" },
  { method: "POST", url: `${reservation}/additional-guests`, key: "pms.reservation.update" },
  {
    method: "PATCH",
    url: `${reservation}/additional-guests/${itemId}`,
    key: "pms.reservation.update",
  },
  {
    method: "DELETE",
    url: `${reservation}/additional-guests/${itemId}`,
    key: "pms.reservation.update",
  },
  { method: "GET", url: `${reservation}/notes`, key: "pms.reservation.read" },
  { method: "POST", url: `${reservation}/notes`, key: "pms.reservation.update" },
  { method: "PATCH", url: `${reservation}/notes/${itemId}`, key: "pms.reservation.update" },
  { method: "DELETE", url: `${reservation}/notes/${itemId}`, key: "pms.reservation.update" },
  { method: "GET", url: `${reservation}/checkout-charges`, key: "pms.reservation.read" },
  { method: "POST", url: `${reservation}/checkout-charges`, key: "pms.reservation.update" },
  {
    method: "GET",
    url: `/properties/${propertyId}/check-in-checklist`,
    key: "pms.reservation.read",
  },
  {
    method: "GET",
    url: `/properties/${propertyId}/check-out-inspection`,
    key: "pms.reservation.read",
  },
  { method: "POST", url: `${reservation}/no-show`, key: "pms.reservation.cancel" },
  { method: "POST", url: `${reservation}/cancel`, key: "pms.reservation.cancel" },
  { method: "POST", url: `/properties/${propertyId}/room-blocks`, key: "pms.calendar.manage" },
  {
    method: "PATCH",
    url: `/properties/${propertyId}/room-blocks/${itemId}`,
    key: "pms.calendar.manage",
  },
  {
    method: "DELETE",
    url: `/properties/${propertyId}/room-blocks/${itemId}`,
    key: "pms.calendar.manage",
  },
  { method: "GET", url: `/properties/${propertyId}/calendar-shuffles`, key: "pms.calendar.read" },
  { method: "GET", url: `/properties/${propertyId}/calendar-settings`, key: "pms.settings.read" },
  {
    method: "PATCH",
    url: `/properties/${propertyId}/calendar-settings`,
    key: "pms.settings.manage",
  },
];
// Money and setup stay with the account admin: no staff key opens them.
const ownerOnly: Route[] = [
  { method: "POST", url: `${reservation}/mark-paid` },
  { method: "POST", url: `${reservation}/refund` },
  { method: "POST", url: `${reservation}/correct-prices` },
  { method: "POST", url: `${reservation}/checkout-charges/${itemId}/waive` },
  { method: "POST", url: `${reservation}/checkout-charges/${itemId}/mark-paid` },
  { method: "PUT", url: `/properties/${propertyId}/check-in-checklist` },
  { method: "PUT", url: `/properties/${propertyId}/check-out-inspection` },
  { method: "PATCH", url: `/properties/${propertyId}/rooms/reorder` },
  { method: "PATCH", url: `/properties/${propertyId}/profile` },
];

describe("PMS daily work for staff roles (VAY-2498)", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(dailyWork)("$method $url: the owner may", async (route) => {
    app = await testApp(owner, { calls: [] });
    expectAllowed(await send(app, route));
  });

  it.each(dailyWork)("$method $url: staff holding $key may", async (route) => {
    expect(agencyManager.permissions).toContain(route.key);
    app = await testApp(agencyManager, { calls: [] });
    expectAllowed(await send(app, route));
  });

  it.each(dailyWork)("$method $url: staff without $key are refused", async (route) => {
    const state = { calls: [] as string[] };
    app = await testApp(without(agencyManager, route.key), state);
    const response = await send(app, route);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "missing_permission",
      message: "Missing required PMS operations permission.",
    });
    expect(state.calls).toEqual([]);
  });

  it.each(dailyWork)(
    "$method $url: staff assigned only to another property are refused",
    async (route) => {
      const state = { calls: [] as string[] };
      app = await testApp(agencyManager, state, { assignedPropertyIds: [otherPropertyId] });
      const response = await send(app, route);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "missing_resource_access" });
      expect(state.calls).toEqual([]);
    },
  );

  it("lets front desk check guests in and out, block rooms and add charges, but not cancel", async () => {
    expect(frontDesk.permissions).toContain("pms.reservation.update");
    expect(frontDesk.permissions).toContain("pms.calendar.manage");
    expect(frontDesk.permissions).not.toContain("pms.reservation.cancel");
    for (const route of dailyWork) {
      app = await testApp(frontDesk, { calls: [] });
      const { statusCode } = await send(app, route);
      expect([route.method, route.url, statusCode === 403]).toEqual([
        route.method,
        route.url,
        !frontDesk.permissions.includes(route.key),
      ]);
      await app.close();
      app = undefined;
    }
  });

  it.each(dailyWork.filter((route) => route.method !== "GET"))(
    "$method $url: housekeeping is refused",
    async (route) => {
      const state = { calls: [] as string[] };
      app = await testApp(housekeeping, state);
      expect((await send(app, route)).statusCode).toBe(403);
      expect(state.calls).toEqual([]);
    },
  );

  it.each(ownerOnly)("$method $url stays with the account admin", async (route) => {
    const allStaffKeys: Actor = {
      roleKey: "hotel_manager",
      permissions: staffAccessPermissionKeys,
    };
    let state = { calls: [] as string[] };
    app = await testApp(allStaffKeys, state);
    const refused = await send(app, route);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "missing_permission" });
    expect(state.calls).toEqual([]);
    await app.close();

    state = { calls: [] };
    app = await testApp(owner, state);
    expectAllowed(await send(app, route));
  });

  it("keeps the finance check when a staff cancel keeps charges", async () => {
    const state = { calls: [] as string[] };
    app = await testApp(agencyManager, state);
    const keepsCharges = await app.inject({
      method: "POST",
      url: `${reservation}/cancel`,
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      payload: JSON.stringify({ retainedCharges: [{ chargeId: itemId }] }),
    });
    expect(keepsCharges.statusCode).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("hides guest email and phone from staff without guest contact access", async () => {
    const withoutContact = without(frontDesk, "pms.guest_contact.read");
    for (const [actor, visible] of [
      [frontDesk, true],
      [withoutContact, false],
    ] as const) {
      const state = { calls: [] as string[], contactReads: [] as boolean[] };
      app = await testApp(actor, state);
      const command = await app.inject({
        method: "PATCH",
        url: `${reservation}/status`,
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        payload: JSON.stringify({ commandId: "c-1", idempotencyKey: "k-1", status: "checked_in" }),
      });
      expect(command.statusCode).toBe(200);
      expect(command.json().reservation.primaryGuest).toMatchObject(
        visible
          ? { email: "ada@example.test", phone: "+43 1 234" }
          : { email: expect.not.stringContaining("@"), phone: expect.not.stringContaining("234") },
      );
      const list = await send(app, { method: "GET", url: `${reservation}/additional-guests` });
      expect(list.statusCode).toBe(200);
      expect(state.contactReads).toEqual([visible]);
      await app.close();
      app = undefined;
    }
  });
});

/** Past every access check: whatever the stubbed repositories answer, it isn't 401 or 403. */
function expectAllowed(response: { statusCode: number; body: string }) {
  expect([401, 403], response.body).not.toContain(response.statusCode);
}

async function send(app: Awaited<ReturnType<typeof testApp>>, route: Route) {
  return app.inject({
    method: route.method,
    url: route.url,
    headers: {
      authorization: "Bearer valid",
      ...(route.method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(route.method === "GET" ? {} : { payload: JSON.stringify({ retainedCharges: [] }) }),
  });
}

/** Any other repository call is recorded and fails, so an allowed request ends after the check. */
function recordingStub<T>(calls: string[], overrides: Record<string, unknown> = {}): T {
  return new Proxy(overrides, {
    get(target, name) {
      if (name === "then") return undefined;
      if (name === "close") return async () => {};
      if (typeof name === "string" && name in target) return target[name];
      return async () => {
        calls.push(String(name));
        throw new Error(`stub ${String(name)}`);
      };
    },
  }) as T;
}

async function testApp(
  actor: Actor,
  state: { calls: string[]; contactReads?: boolean[] },
  scope: { assignedPropertyIds?: string[] } = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = {
      actor: { internalUserId: actorId, status: "active" },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId: "84980000-0000-4000-8000-000000000006",
        roleKey: actor.roleKey,
        status: "active",
        permissions: [...actor.permissions],
        propertyAccess: {
          mode: scope.assignedPropertyIds ? "assigned" : "all",
          roleKey: actor.roleKey,
          accessOrigin: "agency",
          assignedPropertyIds: scope.assignedPropertyIds ?? [],
        },
      },
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
        {
          product: "booking",
          key: "direct-booking-finance",
          status: "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
      ],
      linkedResources: [propertyId, otherPropertyId].flatMap((resourceId) =>
        [
          ["pms", "pms_property"],
          ["hotel_catalog", "property"],
        ].map(([product, resourceType]) => ({
          product,
          resourceType,
          resourceId,
          relationship: "owner",
          status: "active",
        })),
      ),
      audit: { requestId: "request-1", source: "api", receivedAt: "2026-11-15T10:00:00.000Z" },
    } as unknown as RequestContext;
  });
  const guest = { displayName: "Ada", email: "ada@example.test", phone: "+43 1 234" };
  await app.register(registerPmsOperationsRoutes, {
    repository: recordingStub<PmsOperationsReadRepository>(state.calls),
    commandRepository: recordingStub<PmsOperationsCommandRepository>(state.calls, {
      async executeOperationalStatusCommand(command: { commandId: string }) {
        return {
          ok: true,
          reservation: {
            guestBookingId: bookingId,
            primaryGuest: { ...guest, countryCode: "AT", specialRequests: null },
            payment: null,
          },
          commandMeta: { commandId: command.commandId },
        };
      },
    }),
    bookingGuestPiiPort: recordingStub<BookingGuestPiiPort>(state.calls, {
      async listGuestPiiForPmsOperations(input: { canReadGuestContact: boolean }) {
        state.contactReads?.push(input.canReadGuestContact);
        return { primaryGuest: null, additionalGuests: [] };
      },
    }),
    propertyAccessRepository: {
      async findMembershipPropertyScope() {
        return null;
      },
    },
  });
  return app;
}
