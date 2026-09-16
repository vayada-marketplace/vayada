import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export type PmsStaffMember = {
  id: string;
  name: string | null;
  email: string;
  roleKey: "hotel_manager" | "front_desk" | "housekeeping" | "hotel_custom" | "external_owner";
  roleDefinitionId?: string | null;
  roleName?: string | null;
  propertyAccessMode?: "all" | "assigned";
  propertyIds: string[];
  status: "active" | "pending" | "deactivated";
  lastActiveAt: string | null;
};

export async function getPmsStaffRoster(): Promise<PmsStaffMember[]> {
  const response = await pmsOperationsClient.get<{ members: PmsStaffMember[] }>(
    "/api/identity/staff/members",
    pmsOperationsRequestOptions,
  );
  return response.members;
}

export type PmsSelfAccess = {
  membershipId: string;
  roleKey: string;
  permissions: string[];
};

export function getPmsSelfAccess(): Promise<PmsSelfAccess> {
  return pmsOperationsClient.get("/api/identity/staff/self-access", pmsOperationsRequestOptions);
}

export async function updatePmsStaffStatus(
  membershipId: string,
  status: "active" | "deactivated",
): Promise<{ membershipId: string; status: "active" | "deactivated" }> {
  return pmsOperationsClient.patch<{
    membershipId: string;
    status: "active" | "deactivated";
  }>(
    `/api/identity/staff/members/${encodeURIComponent(membershipId)}/status`,
    { status },
    {
      ...pmsOperationsRequestOptions,
      headers: {
        ...(pmsOperationsRequestOptions.headers as Record<string, string>),
        "Idempotency-Key": `pms-staff-status:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
      },
    },
  );
}

export type PmsTeamRole = {
  id: string;
  name: string;
  description: string;
  revision: string;
  securityClass: "account_admin" | "staff" | "housekeeping" | "external_owner";
  baseRoleKey: PmsStaffMember["roleKey"] | "hotel_owner";
  presetKey: string | null;
  defaultPermissions: string[];
  allowedPermissions: string[];
  immutable: boolean;
  memberCount: number;
  invitationCount: number;
};

export type PmsAccountAdmin = {
  membershipId: string;
  name: string | null;
  email: string;
  roleKey: string;
  active: boolean;
  revision: string;
};
export function getPmsAccountAdmins(): Promise<{
  admins: PmsAccountAdmin[];
  actorMembershipId: string;
}> {
  return pmsOperationsClient.get("/api/identity/staff/account-admins", pmsOperationsRequestOptions);
}

export type PmsStaffAccessConfiguration = {
  roleKey: PmsStaffMember["roleKey"];
  propertyAccessMode: "all" | "assigned";
  propertyIds: string[];
  productAccess: { pms: boolean; booking: boolean };
  permissionOverrides: { grant: string[]; deny: string[] };
};

type SavedRoleDefinition = Pick<
  PmsTeamRole,
  "id" | "name" | "revision" | "securityClass" | "baseRoleKey" | "presetKey" | "defaultPermissions"
>;
export type PmsStaffAccess = PmsStaffAccessConfiguration & {
  membershipId: string;
  status: "active" | "suspended";
  revision: string;
  roleDefinitionId: string | null;
  roleDefinition: SavedRoleDefinition | null;
  configuredPermissions: string[];
};
export type PmsStaffInvitation = PmsStaffAccessConfiguration & {
  id: string;
  email: string;
  name: string | null;
  configurationRevision: number;
  roleDefinitionId: string | null;
  roleDefinition: SavedRoleDefinition | null;
  deliveryState: string;
  expiresAt: string | null;
};
export type PmsStaffRoleReference = { roleDefinitionId: string; expectedRoleRevision: string };
export type PmsStaffAccessUpdate = PmsStaffAccessConfiguration &
  Partial<PmsStaffRoleReference> & {
    expectedRevision: string;
    membershipStatus: "active" | "suspended";
  };
export type PmsStaffInviteInput = PmsStaffAccessConfiguration &
  Partial<PmsStaffRoleReference> & {
    email: string;
    name?: string;
    configurationRevision: number;
    expectedInvitationId?: string;
  };
export type PmsRoleInput = Pick<PmsTeamRole, "name" | "description" | "defaultPermissions">;
export type PmsRoleWriteResult = {
  outcome: "created" | "updated" | "deleted" | "idempotent_replay";
  roleId: string;
};
export type PmsInviteResult = {
  outcome: "created" | "idempotent_replay";
  invitationId: string;
  delivery: string;
};

const teamPath = "/api/identity/staff";
// A caller retains this key for retries of the same action/payload.
export function newPmsTeamCommandKey(): string {
  return `pms-team:${crypto.randomUUID()}`;
}
function teamWriteOptions(commandKey: string): RequestInit {
  return {
    ...pmsOperationsRequestOptions,
    headers: { ...pmsOperationsRequestOptions.headers, "Idempotency-Key": commandKey },
  };
}
export function getPmsTeamRoles(): Promise<{ roles: PmsTeamRole[]; canManageRoles: boolean }> {
  return pmsOperationsClient.get(`${teamPath}/roles`, pmsOperationsRequestOptions);
}
export function getPmsStaffAccess(membershipId: string): Promise<PmsStaffAccess> {
  return pmsOperationsClient.get(
    `${teamPath}/members/${encodeURIComponent(membershipId)}/access`,
    pmsOperationsRequestOptions,
  );
}
export function getPmsStaffInvitation(invitationId: string): Promise<PmsStaffInvitation> {
  return pmsOperationsClient.get(
    `${teamPath}/invitations/${encodeURIComponent(invitationId)}`,
    pmsOperationsRequestOptions,
  );
}
export function savePmsStaffAccess(
  membershipId: string,
  access: PmsStaffAccessUpdate,
  commandKey: string,
): Promise<{ outcome: "updated" | "idempotent_replay"; membershipId: string }> {
  return pmsOperationsClient.patch(
    `${teamPath}/members/${encodeURIComponent(membershipId)}`,
    access,
    teamWriteOptions(commandKey),
  );
}
export function invitePmsStaff(
  input: PmsStaffInviteInput,
  commandKey: string,
): Promise<PmsInviteResult> {
  return pmsOperationsClient.post(`${teamPath}/invitations`, input, teamWriteOptions(commandKey));
}
export function preparePmsStaffInvitation(
  email: string,
): Promise<{ configurationRevision: number }> {
  return pmsOperationsClient.post(
    `${teamPath}/invitations/prepare`,
    { email },
    pmsOperationsRequestOptions,
  );
}
// Capture the snapshot once. Retry this exact payload/key after an uncertain response.
export function pmsStaffResendInput(invitation: PmsStaffInvitation): PmsStaffInviteInput {
  if (
    invitation.roleDefinitionId !== null &&
    invitation.roleDefinition?.id !== invitation.roleDefinitionId
  )
    throw new Error("Invitation role is unavailable");
  return {
    email: invitation.email,
    ...(invitation.name ? { name: invitation.name } : {}),
    roleKey: invitation.roleKey,
    propertyAccessMode: invitation.propertyAccessMode,
    propertyIds: [...invitation.propertyIds],
    productAccess: { ...invitation.productAccess },
    permissionOverrides: {
      grant: [...invitation.permissionOverrides.grant],
      deny: [...invitation.permissionOverrides.deny],
    },
    configurationRevision: invitation.configurationRevision + 1,
    expectedInvitationId: invitation.id,
    ...(invitation.roleDefinition
      ? {
          roleDefinitionId: invitation.roleDefinition.id,
          expectedRoleRevision: invitation.roleDefinition.revision,
        }
      : {}),
  };
}
export function removePmsStaff(
  membershipId: string,
  commandKey: string,
): Promise<{
  membershipId: string;
  status: "removed";
  providerStatus: "pending" | "reconciliation_required" | "revoked";
}> {
  return pmsOperationsClient.delete(`${teamPath}/members/${encodeURIComponent(membershipId)}`, {
    ...teamWriteOptions(commandKey),
    body: "{}",
  });
}
export function createPmsTeamRole(
  input: PmsRoleInput & { sourceRoleId?: string },
  commandKey: string,
): Promise<PmsRoleWriteResult> {
  return pmsOperationsClient.post(`${teamPath}/roles`, input, teamWriteOptions(commandKey));
}
export function updatePmsTeamRole(
  roleId: string,
  input: PmsRoleInput & { expectedRevision: string },
  commandKey: string,
): Promise<PmsRoleWriteResult> {
  return pmsOperationsClient.patch(
    `${teamPath}/roles/${encodeURIComponent(roleId)}`,
    input,
    teamWriteOptions(commandKey),
  );
}
export function deletePmsTeamRole(
  roleId: string,
  expectedRevision: string,
  commandKey: string,
): Promise<PmsRoleWriteResult> {
  return pmsOperationsClient.delete(`${teamPath}/roles/${encodeURIComponent(roleId)}`, {
    ...teamWriteOptions(commandKey),
    body: JSON.stringify({ expectedRevision }),
  });
}
