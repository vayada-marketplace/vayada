import { createHash } from "node:crypto";
import { parseStaffPermissionOverrides } from "./lifecycle.js";
import { resolveTeamRolePermissions, type TeamRolePolicy } from "./teamRolePolicy.js";

export type AdminTransferRequest = {
  targetMembershipId: string;
  expectedActorRevision: string;
  expectedTargetRevision: string;
  formerAdmin: {
    roleDefinitionId: string;
    expectedRoleRevision: string;
    propertyAccessMode: "all" | "assigned";
    propertyIds: string[];
    permissionOverrides: { grant: string[]; deny: string[] };
    productAccess: { pms: boolean; booking: boolean };
  };
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** No implicit former-admin defaults. Returns a detached canonical request for preview and hashing. */
export function parseAdminTransferRequest(raw: unknown): AdminTransferRequest | null {
  if (
    !exact(raw, [
      "targetMembershipId",
      "expectedActorRevision",
      "expectedTargetRevision",
      "formerAdmin",
    ]) ||
    !uuid(raw.targetMembershipId) ||
    !revision(raw.expectedActorRevision) ||
    !revision(raw.expectedTargetRevision)
  )
    return null;
  const access = raw.formerAdmin;
  if (
    !exact(access, [
      "roleDefinitionId",
      "expectedRoleRevision",
      "propertyAccessMode",
      "propertyIds",
      "permissionOverrides",
      "productAccess",
    ]) ||
    !uuid(access.roleDefinitionId) ||
    typeof access.expectedRoleRevision !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(access.expectedRoleRevision) ||
    BigInt(access.expectedRoleRevision) > 9223372036854775807n ||
    (access.propertyAccessMode !== "all" && access.propertyAccessMode !== "assigned") ||
    !Array.isArray(access.propertyIds) ||
    !access.propertyIds.every(uuid)
  )
    return null;
  const propertyIds = access.propertyIds.map((id) => id.toLowerCase()).sort();
  if (
    new Set(propertyIds).size !== propertyIds.length ||
    (access.propertyAccessMode === "all" ? propertyIds.length !== 0 : propertyIds.length === 0)
  )
    return null;
  const overrides = parseStaffPermissionOverrides(access.permissionOverrides);
  const products = access.productAccess;
  if (
    !overrides ||
    new Set([...overrides.grant, ...overrides.deny]).size !==
      overrides.grant.length + overrides.deny.length ||
    !exact(products, ["pms", "booking"]) ||
    typeof products.pms !== "boolean" ||
    typeof products.booking !== "boolean"
  )
    return null;
  return {
    targetMembershipId: raw.targetMembershipId.toLowerCase(),
    expectedActorRevision: raw.expectedActorRevision,
    expectedTargetRevision: raw.expectedTargetRevision,
    formerAdmin: {
      roleDefinitionId: access.roleDefinitionId.toLowerCase(),
      expectedRoleRevision: access.expectedRoleRevision,
      propertyAccessMode: access.propertyAccessMode as "all" | "assigned",
      propertyIds,
      permissionOverrides: { grant: [...overrides.grant].sort(), deny: [...overrides.deny].sort() },
      productAccess: { pms: products.pms, booking: products.booking },
    },
  };
}

export type AdminTransferValidationContext = {
  organizationId: string;
  actorMembershipId: string;
  actorRevision: string;
  targetMembershipId: string;
  targetRevision: string;
  role: TeamRolePolicy & { id: string; organizationId: string; revision: string };
  /** Active canonical properties belonging to this organization, read under command locks. */
  propertyIds: readonly string[];
};

/** Authorize/lock active actor, target and organization before constructing this database snapshot.
 * This validates revisions and resulting access, not ownership or provider authentication.
 */
export function validateAdminTransferRequest(
  raw: unknown,
  current: AdminTransferValidationContext,
):
  | { ok: true; request: AdminTransferRequest; requestDigest: string }
  | { ok: false; error: "invalid_transfer" | "stale_transfer" | "invalid_former_admin_access" } {
  const request = parseAdminTransferRequest(raw);
  if (
    !request ||
    !uuid(current.organizationId) ||
    !uuid(current.actorMembershipId) ||
    request.targetMembershipId === current.actorMembershipId.toLowerCase() ||
    request.targetMembershipId !== current.targetMembershipId.toLowerCase()
  )
    return { ok: false, error: "invalid_transfer" };
  const access = request.formerAdmin;
  const role = current.role;
  if (
    request.expectedActorRevision !== current.actorRevision ||
    request.expectedTargetRevision !== current.targetRevision ||
    access.expectedRoleRevision !== role.revision
  )
    return { ok: false, error: "stale_transfer" };
  if (
    role.id.toLowerCase() !== access.roleDefinitionId ||
    role.organizationId.toLowerCase() !== current.organizationId.toLowerCase() ||
    !["staff", "housekeeping"].includes(role.securityClass) ||
    resolveTeamRolePermissions(role, access.permissionOverrides) === null ||
    access.propertyIds.some(
      (id) => !current.propertyIds.some((property) => property.toLowerCase() === id),
    )
  ) {
    return { ok: false, error: "invalid_former_admin_access" };
  }
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: "account-admin-transfer.v1",
        organizationId: current.organizationId.toLowerCase(),
        actorMembershipId: current.actorMembershipId.toLowerCase(),
        ...request,
      }),
    )
    .digest("hex");
  return { ok: true, request, requestDigest };
}
