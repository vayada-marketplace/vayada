import { describe, expect, it } from "vitest";
import {
  parseAdminTransferRequest,
  validateAdminTransferRequest,
  type AdminTransferRequest,
  type AdminTransferValidationContext,
} from "./accountAdminTransferValidation.js";
const id = (n: number) => `14390000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (): AdminTransferRequest => ({
  targetMembershipId: id(2),
  expectedActorRevision: "a".repeat(64),
  expectedTargetRevision: "b".repeat(64),
  formerAdmin: {
    roleDefinitionId: id(3),
    expectedRoleRevision: "2",
    propertyAccessMode: "assigned",
    propertyIds: [id(5), id(4)],
    permissionOverrides: { grant: [], deny: [] },
    productAccess: { pms: true, booking: false },
  },
});
const context = (): AdminTransferValidationContext => ({
  organizationId: id(9),
  actorMembershipId: id(1),
  targetMembershipId: id(2),
  actorRevision: "a".repeat(64),
  targetRevision: "b".repeat(64),
  propertyIds: [id(4), id(5)],
  role: {
    id: id(3),
    organizationId: id(9),
    revision: "2",
    securityClass: "staff",
    baseRoleKey: "front_desk",
    presetKey: "front_desk",
    defaultPermissions: ["pms.calendar.read"],
  },
});
const digest = (r = request(), c = context()) => {
  const result = validateAdminTransferRequest(r, c);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.requestDigest;
};

describe("admin transfer request validation", () => {
  it("requires complete explicit access, rejects extra fields and malformed values", () => {
    for (const key of Object.keys(request())) {
      const raw = { ...request() };
      delete raw[key as keyof typeof raw];
      expect(parseAdminTransferRequest(raw)).toBeNull();
    }
    for (const key of Object.keys(request().formerAdmin)) {
      const raw = request();
      delete (raw.formerAdmin as unknown as Record<string, unknown>)[key];
      expect(parseAdminTransferRequest(raw)).toBeNull();
    }
    for (const formerAdmin of [
      { ...request().formerAdmin, admin: true },
      { ...request().formerAdmin, expectedRoleRevision: "0" },
      { ...request().formerAdmin, expectedRoleRevision: "9223372036854775808" },
      { ...request().formerAdmin, propertyAccessMode: {} },
      { ...request().formerAdmin, productAccess: { pms: true } },
      { ...request().formerAdmin, permissionOverrides: null },
    ]) {
      expect(parseAdminTransferRequest({ ...request(), formerAdmin })).toBeNull();
    }
    expect(parseAdminTransferRequest({ ...request(), proofId: "unexpected" })).toBeNull();
  });
  it("rejects self-transfer, stale member/role revisions and foreign role/property scope", () => {
    expect(
      validateAdminTransferRequest({ ...request(), targetMembershipId: id(1) }, context()).ok,
    ).toBe(false);
    for (const key of ["actorRevision", "targetRevision"] as const)
      expect(
        validateAdminTransferRequest(request(), { ...context(), [key]: "c".repeat(64) }),
      ).toEqual({ ok: false, error: "stale_transfer" });
    expect(
      validateAdminTransferRequest(request(), {
        ...context(),
        role: { ...context().role, revision: "3" },
      }),
    ).toEqual({ ok: false, error: "stale_transfer" });
    for (const role of [
      { ...context().role, id: id(8) },
      { ...context().role, organizationId: id(8) },
    ])
      expect(validateAdminTransferRequest(request(), { ...context(), role }).ok).toBe(false);
    expect(validateAdminTransferRequest(request(), { ...context(), propertyIds: [id(4)] }).ok).toBe(
      false,
    );
  });
  it("enforces resulting staff class ceilings and permission hierarchy", () => {
    for (const grant of [
      ["finance.billing.manage"],
      ["identity.staff.manage"],
      ["pms.calendar.manage", "unknown"],
    ]) {
      const raw = request();
      raw.formerAdmin.permissionOverrides.grant = grant;
      expect(validateAdminTransferRequest(raw, context()).ok).toBe(false);
    }
    const raw = request();
    raw.formerAdmin.permissionOverrides.grant = ["pms.calendar.manage"];
    expect(validateAdminTransferRequest(raw, context()).ok).toBe(true);
    expect(
      validateAdminTransferRequest(raw, {
        ...context(),
        role: { ...context().role, defaultPermissions: [] },
      }).ok,
    ).toBe(false);
    for (const securityClass of ["account_admin", "external_owner"] as const)
      expect(
        validateAdminTransferRequest(request(), {
          ...context(),
          role: { ...context().role, securityClass },
        }).ok,
      ).toBe(false);
  });
  it("enforces unambiguous assigned/all scope and detached canonical arrays", () => {
    const raw = request();
    const parsed = parseAdminTransferRequest(raw)!;
    expect(parsed.formerAdmin.propertyIds).toEqual([id(4), id(5)]);
    raw.formerAdmin.propertyIds.length = 0;
    expect(parsed.formerAdmin.propertyIds).toHaveLength(2);
    expect(parseAdminTransferRequest(raw)).toBeNull();
    raw.formerAdmin.propertyAccessMode = "all";
    expect(parseAdminTransferRequest(raw)).not.toBeNull();
    raw.formerAdmin.propertyIds = [id(4)];
    expect(parseAdminTransferRequest(raw)).toBeNull();
    raw.formerAdmin.propertyAccessMode = "assigned";
    raw.formerAdmin.propertyIds.push(id(4));
    expect(parseAdminTransferRequest(raw)).toBeNull();
  });
  it("binds every reviewed field while ignoring object/array ordering", () => {
    const initial = digest();
    const reordered = request();
    reordered.formerAdmin.propertyIds.reverse();
    expect(digest(reordered)).toBe(initial);
    const changed = request();
    changed.formerAdmin.productAccess.booking = true;
    expect(digest(changed)).not.toBe(initial);
    const permissions = request();
    permissions.formerAdmin.permissionOverrides.grant = ["pms.calendar.manage"];
    expect(digest(permissions)).not.toBe(initial);
    const scope = request();
    scope.formerAdmin.propertyIds = [id(4)];
    expect(digest(scope)).not.toBe(initial);
    const target = request();
    target.targetMembershipId = id(7);
    expect(digest(target, { ...context(), targetMembershipId: id(7) })).not.toBe(initial);
    expect(digest(request(), { ...context(), actorMembershipId: id(8) })).not.toBe(initial);
    const actorRevision = request();
    actorRevision.expectedActorRevision = "c".repeat(64);
    expect(digest(actorRevision, { ...context(), actorRevision: "c".repeat(64) })).not.toBe(
      initial,
    );
  });
});
