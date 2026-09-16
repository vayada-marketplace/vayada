import {
  externalOwnerPermissionCeiling,
  hasValidStaffPermissionHierarchy,
  parseStaffPermissionOverrides,
  staffAccessPermissionKeys,
} from "./lifecycle.js";
import type { PermissionKey } from "./types.js";

export type TeamRoleSecurityClass = "account_admin" | "staff" | "housekeeping" | "external_owner";
export type TeamRolePolicy = {
  securityClass: TeamRoleSecurityClass;
  baseRoleKey: string;
  presetKey: string | null;
  defaultPermissions: unknown;
};

export const teamRolePresetBases = {
  account_admin: { securityClass: "account_admin", baseRoleKey: "hotel_owner" },
  agency_manager: { securityClass: "staff", baseRoleKey: "hotel_manager" },
  property_owner: { securityClass: "external_owner", baseRoleKey: "external_owner" },
  reservation_manager: { securityClass: "staff", baseRoleKey: "hotel_custom" },
  front_desk: { securityClass: "staff", baseRoleKey: "front_desk" },
  housekeeping: { securityClass: "housekeeping", baseRoleKey: "housekeeping" },
} as const;

// External-owner ceilings permit property operations, not agency administration.
// The new owner preset will use read-only defaults within this ceiling.

export function teamRolePermissionCeiling(policy: TeamRolePolicy): readonly PermissionKey[] | null {
  const bases: Record<TeamRoleSecurityClass, readonly string[]> = {
    account_admin: ["hotel_owner"],
    staff: ["hotel_manager", "front_desk", "hotel_custom"],
    housekeeping: ["housekeeping"],
    external_owner: ["external_owner"],
  };
  if (
    !Object.hasOwn(bases, policy.securityClass) ||
    !bases[policy.securityClass].includes(policy.baseRoleKey)
  )
    return null;
  if (policy.presetKey !== null) {
    const preset = Object.hasOwn(teamRolePresetBases, policy.presetKey)
      ? teamRolePresetBases[policy.presetKey as keyof typeof teamRolePresetBases]
      : undefined;
    if (
      !preset ||
      preset.securityClass !== policy.securityClass ||
      preset.baseRoleKey !== policy.baseRoleKey
    )
      return null;
  }
  if (policy.securityClass === "account_admin")
    return policy.presetKey === "account_admin" ? [] : null;
  if (policy.securityClass === "external_owner")
    return [...externalOwnerPermissionCeiling] as PermissionKey[];
  return staffAccessPermissionKeys.filter(
    (key) =>
      key !== "finance.billing.manage" &&
      (key !== "identity.staff.manage" || policy.presetKey === "agency_manager") &&
      (key !== "pms.guest_contact.read" || policy.securityClass !== "housekeeping"),
  );
}

export function validateTeamRoleDefaults(policy: TeamRolePolicy): boolean {
  const ceiling = teamRolePermissionCeiling(policy);
  const keys = policy.defaultPermissions;
  return (
    ceiling !== null &&
    Array.isArray(keys) &&
    keys.every(
      (key): key is PermissionKey =>
        typeof key === "string" && ceiling.includes(key as PermissionKey),
    ) &&
    new Set(keys).size === keys.length &&
    hasValidStaffPermissionHierarchy(new Set(keys))
  );
}

export function resolveTeamRolePermissions(
  policy: TeamRolePolicy,
  rawOverrides: unknown,
  adminPermissions: readonly PermissionKey[] = [],
): PermissionKey[] | null {
  if (!validateTeamRoleDefaults(policy)) return null;
  const overrides =
    rawOverrides === null ? { grant: [], deny: [] } : parseStaffPermissionOverrides(rawOverrides);
  if (
    !overrides ||
    new Set(overrides.grant).size !== overrides.grant.length ||
    new Set(overrides.deny).size !== overrides.deny.length ||
    overrides.grant.some((key) => overrides.deny.includes(key))
  )
    return null;
  if (policy.securityClass === "account_admin") {
    return overrides.grant.length === 0 && overrides.deny.length === 0
      ? [...adminPermissions]
      : null;
  }
  const ceiling = new Set(teamRolePermissionCeiling(policy)!);
  if ([...overrides.grant, ...overrides.deny].some((key) => !ceiling.has(key as PermissionKey)))
    return null;
  const permissions = new Set(policy.defaultPermissions as PermissionKey[]);
  for (const key of overrides.grant) permissions.add(key as PermissionKey);
  for (const key of overrides.deny) permissions.delete(key as PermissionKey);
  return hasValidStaffPermissionHierarchy(permissions) ? [...permissions].sort() : null;
}
