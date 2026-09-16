import { beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: transport,
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
import {
  deletePmsTeamRole,
  removePmsStaff,
  invitePmsStaff,
  pmsStaffResendInput,
  type PmsStaffInvitation,
} from "./pmsStaffClient";

beforeEach(() => vi.clearAllMocks());
const invitation: PmsStaffInvitation = {
  id: "invite-1",
  email: "worker@example.com",
  name: "Night shift",
  roleKey: "front_desk",
  roleDefinitionId: "role-1",
  roleDefinition: {
    id: "role-1",
    name: "Night shift",
    revision: "9",
    securityClass: "staff",
    baseRoleKey: "front_desk",
    presetKey: null,
    defaultPermissions: ["pms.calendar.read"],
  },
  propertyAccessMode: "all",
  propertyIds: [],
  productAccess: { pms: true, booking: false },
  permissionOverrides: { grant: ["pms.inbox.read"], deny: ["pms.calendar.read"] },
  configurationRevision: 4,
  deliveryState: "delivered",
  expiresAt: null,
};

it("resends the captured configuration with a stable retry key and both revisions", async () => {
  const snapshot = structuredClone(invitation);
  const input = pmsStaffResendInput(snapshot);
  snapshot.permissionOverrides.grant.push("pms.inbox.reply");
  snapshot.productAccess.booking = true;
  snapshot.roleDefinition!.revision = "10";
  transport.post.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({
    outcome: "idempotent_replay",
    invitationId: "invite-2",
    delivery: "not_ready",
  });
  await expect(invitePmsStaff(input, "same-action")).rejects.toThrow("Connection lost");
  await expect(invitePmsStaff(input, "same-action")).resolves.toMatchObject({
    outcome: "idempotent_replay",
  });
  expect(transport.post.mock.calls[0]).toEqual(transport.post.mock.calls[1]);
  expect(input).toEqual({
    email: invitation.email,
    name: invitation.name,
    roleKey: "front_desk",
    roleDefinitionId: "role-1",
    expectedRoleRevision: "9",
    propertyAccessMode: "all",
    propertyIds: [],
    productAccess: { pms: true, booking: false },
    permissionOverrides: invitation.permissionOverrides,
    configurationRevision: 5,
    expectedInvitationId: "invite-1",
  });
});

it("preserves legacy invitations and rejects missing saved role definitions", () => {
  const legacy = pmsStaffResendInput({
    ...invitation,
    roleDefinitionId: null,
    roleDefinition: null,
  });
  expect(legacy).not.toHaveProperty("roleDefinitionId");
  expect(legacy).not.toHaveProperty("expectedRoleRevision");
  expect(() => pmsStaffResendInput({ ...invitation, roleDefinition: null })).toThrow(
    "Invitation role is unavailable",
  );
});

it("sends optimistic role deletion revision in the DELETE body", async () => {
  await deletePmsTeamRole("role/1", "6", "delete-action");
  expect(transport.delete).toHaveBeenCalledWith("/api/identity/staff/roles/role%2F1", {
    cache: "no-store",
    headers: { "Idempotency-Key": "delete-action" },
    body: '{"expectedRevision":"6"}',
  });
});

it("provides a JSON body for removal so Fastify accepts the content type", async () => {
  transport.delete.mockResolvedValueOnce({
    membershipId: "member-1",
    status: "removed",
    providerStatus: "pending",
  });
  await expect(removePmsStaff("member-1", "remove-action")).resolves.toMatchObject({
    providerStatus: "pending",
  });
  expect(transport.delete).toHaveBeenCalledWith("/api/identity/staff/members/member-1", {
    cache: "no-store",
    headers: { "Idempotency-Key": "remove-action" },
    body: "{}",
  });
});
