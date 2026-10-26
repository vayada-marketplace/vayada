import { BOOKING_GUEST_POLICY_AUTHORIZATION } from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("Booking guest-policy scope authorization", () => {
  it("checks the exact permission, entitlement, resource, and bounded query", async () => {
    const query = memberPool(["booking.settings.read", "booking.settings.manage"]);
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    await expect(port.authorizeGuestPolicyScope(input())).resolves.toBe(true);
    await expect(
      port.authorizeGuestPolicyScope({ ...input(), permission: "booking.settings.read" }),
    ).resolves.toBe(true);
    expect(query.mock.calls.every(([request]) => request.query_timeout === 5_000)).toBe(true);
    const request = query.mock.calls[0]![0];
    expect(request.text).not.toContain("role_permission_grants");
    expect(request.text).toContain("entitlement.status = 'suspended'");
    expect(request.values).toEqual([
      organizationId,
      propertyId,
      actorUserId,
      BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.product,
      BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.key,
      BOOKING_GUEST_POLICY_AUTHORIZATION.resource.product,
      BOOKING_GUEST_POLICY_AUTHORIZATION.resource.resourceType,
      [...BOOKING_GUEST_POLICY_AUTHORIZATION.resource.allowedRelationships],
      "2026-08-05T13:00:00.000Z",
    ]);
  });

  it("checks the member's team-role permissions like the route (VAY-2335)", async () => {
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({
      pool: { query: memberPool(["booking.settings.read"]) } as never,
    });
    await expect(
      port.authorizeGuestPolicyScope({ ...input(), permission: "booking.settings.read" }),
    ).resolves.toBe(true);
    await expect(port.authorizeGuestPolicyScope(input())).resolves.toBe(false);
  });

  it("fails closed before SQL for malformed scope and on provider failure", async () => {
    const query = vi.fn(async (_request: unknown) => {
      throw new Error("unavailable");
    });
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    await expect(
      port.authorizeGuestPolicyScope({ ...input(), propertyId: "not-a-uuid" }),
    ).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    await expect(port.authorizeGuestPolicyScope(input())).resolves.toBe(false);
  });

  it("fails closed for mismatched authorization metadata and timestamps", async () => {
    const query = vi.fn(async () => ({ rows: [{ authorized: true }], rowCount: 1 }));
    const port = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: { query } as never });
    const rejected = [
      { ...input(), permission: "booking.reservations.read" },
      { ...input(), entitlement: { ...input().entitlement, key: "other-key" } },
      { ...input(), resource: { ...input().resource, resourceType: "other_type" } },
      { ...input(), resource: { ...input().resource, allowedRelationships: [] } },
      { ...input(), checkedAt: "2026-08-05T13:00:00Z" },
      { ...input(), checkedAt: "not-a-timestamp" },
    ];

    for (const candidate of rejected) {
      await expect(port.authorizeGuestPolicyScope(candidate as never)).resolves.toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

// A custom-role member: hotel_custom has no grant rows, so permissions come from the team-role.
function memberPool(defaultPermissions: string[]) {
  const roleId = "44444444-4444-4444-8444-444444444444";
  return vi.fn(async (request: { text: string; values: unknown[]; query_timeout: number }) => {
    const rows = request.text.includes("SELECT true AS authorized")
      ? [{ authorized: true }]
      : request.text.includes("FROM identity.organization_memberships")
        ? [
            {
              id: "55555555-5555-4555-8555-555555555555",
              roleKey: "hotel_custom",
              mode: "all",
              accessOrigin: "agency",
              permissionOverrides: null,
              roleDefinitionId: roleId,
              pms: true,
              booking: true,
            },
          ]
        : request.text.includes("FROM identity.organization_roles")
          ? [
              {
                id: roleId,
                organizationId,
                securityClass: "staff",
                baseRoleKey: "hotel_custom",
                presetKey: null,
                defaultPermissions,
              },
            ]
          : [];
    return { rows, rowCount: rows.length };
  });
}

function input() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
    entitlement: BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement,
    resource: BOOKING_GUEST_POLICY_AUTHORIZATION.resource,
    checkedAt: "2026-08-05T13:00:00.000Z",
  };
}
