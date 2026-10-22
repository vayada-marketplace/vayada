import { describe, expect, it, vi } from "vitest";

import {
  createStaffInvitationDeliveryCoordinator,
  type StaffInvitationDeliveryClaim,
  type StaffInvitationDeliveryRepository,
  type StaffInvitationProvider,
} from "./staffInvitationDelivery.js";

const claim: StaffInvitationDeliveryClaim = {
  invitationId: "11111111-1111-4111-8111-111111111111",
  email: "staff@example.com",
  organizationId: "org_workos",
  inviterUserId: "user_workos_owner",
  roleSlug: "hotel_member",
};

function setup(input: { replaced?: string | null; revoke?: () => Promise<never> } = {}) {
  const repository: StaffInvitationDeliveryRepository = {
    claim: vi.fn(async () => claim),
    markDelivered: vi.fn(async () => true),
    markUnknown: vi.fn(async () => {}),
    findReplacedProviderInvitationId: vi.fn(async () => input.replaced ?? null),
  };
  const provider = {
    sendInvitation: vi.fn<StaffInvitationProvider["sendInvitation"]>(async (sent) => ({
      invitationId: "invitation_new",
      email: sent.email,
      organizationId: sent.organizationId,
      inviterUserId: sent.inviterUserId,
      roleSlug: sent.roleSlug,
      state: "pending",
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })),
    revokeInvitation: vi.fn<StaffInvitationProvider["revokeInvitation"]>(
      input.revoke ?? (async () => "revoked"),
    ),
  };
  return {
    repository,
    provider,
    coordinator: createStaffInvitationDeliveryCoordinator({ repository, provider }),
  };
}

describe("staff invitation delivery (VAY-2274 Resend)", () => {
  it("revokes the WorkOS invitation a resend replaced, after the new one is out", async () => {
    const { coordinator, provider } = setup({ replaced: "invitation_old" });

    const outcome = await coordinator.deliver(claim.invitationId);

    expect(outcome).toEqual({
      outcome: "delivered",
      invitationId: claim.invitationId,
      providerInvitationId: "invitation_new",
      replacedRevocation: "revoked",
    });
    expect(provider.revokeInvitation).toHaveBeenCalledWith("invitation_old");
    expect(provider.sendInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      provider.revokeInvitation.mock.invocationCallOrder[0]!,
    );
  });

  it("revokes nothing for a first invitation", async () => {
    const { coordinator, provider } = setup();

    const outcome = await coordinator.deliver(claim.invitationId);

    expect(outcome).toEqual({
      outcome: "delivered",
      invitationId: claim.invitationId,
      providerInvitationId: "invitation_new",
    });
    expect(provider.revokeInvitation).not.toHaveBeenCalled();
  });

  it("keeps the delivery when revoking the replaced invitation fails", async () => {
    const { coordinator } = setup({
      replaced: "invitation_old",
      revoke: async () => {
        throw new Error("WorkOS unavailable");
      },
    });

    await expect(coordinator.deliver(claim.invitationId)).resolves.toMatchObject({
      outcome: "delivered",
      replacedRevocation: "failed",
    });
  });

  it("leaves the old invitation alone when the new one could not be sent", async () => {
    const { coordinator, provider, repository } = setup({ replaced: "invitation_old" });
    provider.sendInvitation.mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(coordinator.deliver(claim.invitationId)).resolves.toEqual({
      outcome: "unknown",
      invitationId: claim.invitationId,
    });
    expect(repository.findReplacedProviderInvitationId).not.toHaveBeenCalled();
    expect(provider.revokeInvitation).not.toHaveBeenCalled();
  });
});
