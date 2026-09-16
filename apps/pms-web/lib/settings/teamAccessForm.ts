import type {
  PmsStaffAccess,
  PmsStaffAccessConfiguration,
  PmsTeamRole,
} from "@/services/api/pmsStaffClient";
import { memberPermissionOverrides } from "./teamPermissions";

export type TeamAccessDraft = {
  roleId: string;
  permissions: string[];
  resetOverrides: boolean;
  propertyAccessMode: "all" | "assigned";
  propertyIds: string[];
  productAccess: { pms: boolean; booking: boolean };
  status: "active" | "suspended";
};

export function initialTeamAccess(access?: PmsStaffAccess): TeamAccessDraft {
  return {
    roleId: access?.roleDefinitionId ?? "",
    permissions: [...(access?.configuredPermissions ?? [])],
    resetOverrides: false,
    propertyAccessMode: access?.propertyAccessMode ?? "assigned",
    propertyIds: [...(access?.propertyIds ?? [])],
    productAccess: { ...(access?.productAccess ?? { pms: true, booking: false }) },
    status: access?.status ?? "active",
  };
}

// Keep explicit overrides, including redundant ones, unless that permission was edited.
export function preservePermissionOverrides(access: PmsStaffAccess, desired: string[]) {
  const grant = new Set(access.permissionOverrides.grant);
  const deny = new Set(access.permissionOverrides.deny);
  for (const key of access.configuredPermissions) {
    if (!desired.includes(key)) {
      grant.delete(key);
      deny.add(key);
    }
  }
  for (const key of desired) {
    if (!access.configuredPermissions.includes(key)) {
      deny.delete(key);
      grant.add(key);
    }
  }
  return { grant: Array.from(grant), deny: Array.from(deny) };
}

export function assignableTeamRoles(roles: PmsTeamRole[], canManageRoles: boolean) {
  return roles.filter(
    (role) =>
      role.securityClass !== "account_admin" &&
      (canManageRoles ||
        (role.securityClass !== "external_owner" &&
          role.presetKey !== "agency_manager" &&
          !role.defaultPermissions.includes("identity.staff.manage"))),
  );
}

export function teamAccessConfiguration(
  draft: TeamAccessDraft,
  roles: PmsTeamRole[],
  access?: PmsStaffAccess,
): PmsStaffAccessConfiguration & { roleDefinitionId?: string; expectedRoleRevision?: string } {
  const role = roles.find((item) => item.id === draft.roleId);
  const sameRole = !!access && draft.roleId === (access.roleDefinitionId ?? "");
  if ((!role && (!sameRole || access?.roleDefinitionId)) || role?.baseRoleKey === "hotel_owner")
    throw new Error("Team role is unavailable");
  if (access && !sameRole && !draft.resetOverrides)
    throw new Error("Confirm replacing member overrides before changing role");
  const roleKey = role?.baseRoleKey ?? access!.roleKey;
  if (roleKey === "external_owner" && draft.propertyAccessMode !== "assigned")
    throw new Error("External owners require assigned properties");
  return {
    roleKey,
    propertyAccessMode: draft.propertyAccessMode,
    propertyIds: draft.propertyAccessMode === "all" ? [] : [...draft.propertyIds],
    productAccess: { ...draft.productAccess },
    permissionOverrides:
      sameRole && !draft.resetOverrides
        ? preservePermissionOverrides(access!, draft.permissions)
        : memberPermissionOverrides(role?.defaultPermissions ?? [], draft.permissions),
    ...(role
      ? {
          roleDefinitionId: role.id,
          // A catalog fetched after the access snapshot must not silently change its meaning.
          expectedRoleRevision: sameRole ? access!.roleDefinition!.revision : role.revision,
        }
      : {}),
  };
}
