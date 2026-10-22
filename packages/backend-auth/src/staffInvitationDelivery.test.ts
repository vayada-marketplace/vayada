import { describe, expect, it, vi } from "vitest";

import {
  createStaffInvitationDeliveryCoordinator,
  type ReplacedInvitationRevocation,
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

const replaced: ReplacedInvitationRevocation = {
  invitationId: "22222222-2222-4222-8222-222222222222",
  providerInvitationId: "invitation_old",
};

// A store that behaves like the claim query: an unconfirmed revoke is due again once claimed.
function setup(input: { replaced?: boolean } = {}) {
  let confirmed = !input.replaced;
  const repository: StaffInvitationDeliveryRepository = {
    claim: vi.fn(async () => claim),
    markDelivered: vi.fn(async () => true),
    markUnknown: vi.fn(async () => {}),
    claimReplacedRevocations: vi.fn(async () => (confirmed ? [] : [replaced])),
    markProviderRevoked: vi.fn(async () => {
      confirmed = true;
    }),
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
    revokeInvitation: vi.fn<StaffInvitationProvider["revokeInvitation"]>(async () => "revoked"),
  };
  return {
    repository,
    provider,
    coordinator: createStaffInvitationDeliveryCoordinator({ repository, provider }),
  };
}

describe("staff invitation delivery (VAY-2274 Resend)", () => {
  it("revokes the WorkOS invitation a resend replaced, after the new one is out", async () => {
    const { coordinator, provider, repository } = setup({ replaced: true });

    const outcome = await coordinator.deliver(claim.invitationId);

    expect(outcome).toEqual({
      outcome: "delivered",
      invitationId: claim.invitationId,
      providerInvitationId: "invitation_new",
      replacedRevocation: "revoked",
    });
    expect(repository.claimReplacedRevocations).toHaveBeenCalledWith({
      replacedBy: claim.invitationId,
    });
    expect(provider.revokeInvitation).toHaveBeenCalledWith("invitation_old");
    expect(repository.markProviderRevoked).toHaveBeenCalledWith(replaced);
    expect(provider.sendInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      provider.revokeInvitation.mock.invocationCallOrder[0]!,
    );
  });

  it("ends revoked when the first revoke fails: the sweep retries until WorkOS confirms", async () => {
    const { coordinator, provider, repository } = setup({ replaced: true });
    provider.revokeInvitation.mockRejectedValueOnce(new Error("WorkOS unavailable"));

    await expect(coordinator.deliver(claim.invitationId)).resolves.toMatchObject({
      outcome: "delivered",
      replacedRevocation: "failed",
    });
    expect(repository.markProviderRevoked).not.toHaveBeenCalled();

    await expect(coordinator.revokeReplacedInvitations()).resolves.toBe("revoked");
    expect(provider.revokeInvitation).toHaveBeenCalledTimes(2);
    expect(repository.markProviderRevoked).toHaveBeenCalledWith(replaced);

    // Confirmed: later sweeps find nothing to do.
    await expect(coordinator.revokeReplacedInvitations()).resolves.toBeUndefined();
    expect(provider.revokeInvitation).toHaveBeenCalledTimes(2);
  });

  it("treats an invitation WorkOS no longer has pending as revoked", async () => {
    const { coordinator, provider, repository } = setup({ replaced: true });
    provider.revokeInvitation.mockResolvedValueOnce("not_pending");

    await expect(coordinator.revokeReplacedInvitations()).resolves.toBe("revoked");
    expect(repository.markProviderRevoked).toHaveBeenCalledWith(replaced);
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

  it("leaves the old invitation alone when the new one could not be sent", async () => {
    const { coordinator, provider, repository } = setup({ replaced: true });
    provider.sendInvitation.mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(coordinator.deliver(claim.invitationId)).resolves.toEqual({
      outcome: "unknown",
      invitationId: claim.invitationId,
    });
    expect(repository.claimReplacedRevocations).not.toHaveBeenCalled();
    expect(provider.revokeInvitation).not.toHaveBeenCalled();
  });
});
