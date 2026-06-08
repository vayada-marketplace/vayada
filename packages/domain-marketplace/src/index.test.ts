import { describe, expect, it } from "vitest";

import {
  AFFILIATE_PROVISIONING_ERROR_CODES,
  AFFILIATE_PROVISIONING_STATUSES,
  COLLABORATION_STATUSES,
  MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
  buildAffiliateProvisioningCommandId,
  buildAffiliateProvisioningIdempotencyKey,
  type AffiliateProvisionedEvent,
  type AffiliateProvisioningResult,
  type CollaborationAcceptedEvent,
  type CollaborationAffiliatePort,
  type ProvisionCollaborationAffiliateCommand,
} from "./index.js";

describe("@vayada/domain-marketplace", () => {
  it("exports the affiliate contract version", () => {
    expect(MARKETPLACE_AFFILIATE_CONTRACT_VERSION).toBe("marketplace-affiliate.v1");
  });

  it("exports collaboration statuses including accepted", () => {
    expect(COLLABORATION_STATUSES).toContain("accepted");
    expect(COLLABORATION_STATUSES).toContain("pending");
    expect(COLLABORATION_STATUSES).toContain("completed");
  });

  it("exports affiliate provisioning statuses", () => {
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("provisioned");
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("already_exists");
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("failed");
  });

  it("exports affiliate provisioning error codes", () => {
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("HOTEL_NOT_FOUND");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("DUPLICATE_AFFILIATE");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("RETRYABLE_DOWNSTREAM_FAILURE");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("IDEMPOTENCY_CONFLICT");
  });

  it("buildAffiliateProvisioningIdempotencyKey produces a stable key", () => {
    const key = buildAffiliateProvisioningIdempotencyKey({
      collaborationId: "collab_abc123",
    });
    expect(key).toBe("marketplace.affiliate.provision:collaboration:collab_abc123:v1");
    // Calling again with the same input produces the same key (idempotent)
    expect(buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_abc123" })).toBe(
      key,
    );
  });

  it("buildAffiliateProvisioningIdempotencyKey uses the collaborationId as the scope", () => {
    const key1 = buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_1" });
    const key2 = buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_2" });
    expect(key1).not.toBe(key2);
  });

  it("allows an implementation of CollaborationAffiliatePort to be typed correctly", async () => {
    const command: ProvisionCollaborationAffiliateCommand = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_test_001",
      idempotencyKey: buildAffiliateProvisioningIdempotencyKey({
        collaborationId: "collab_test_001",
      }),
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_hotel_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "creator",
        actorId: "creator_001",
        source: "marketplace_web",
        occurredAt: "2026-06-07T10:00:00.000Z",
      },
      collaboration: {
        collaborationId: "collab_test_001",
        status: "accepted",
        acceptedAt: "2026-06-07T10:00:00.000Z",
      },
      creator: {
        creatorId: "creator_001",
        creatorName: "Ada Lovelace",
        creatorEmail: "ada@example.com",
        socialMediaSummary: "Instagram: @ada",
      },
      hotel: {
        marketplaceHotelProfileId: "mhp_001",
        organizationId: "org_hotel_001",
      },
      commissionTerms: {
        commissionPct: "5.00",
        currency: null,
      },
    };

    // Fake implementation of the port — Finance/affiliate domain owns this
    const fakePort: CollaborationAffiliatePort = {
      async provisionAffiliate(
        cmd: ProvisionCollaborationAffiliateCommand,
      ): Promise<AffiliateProvisioningResult> {
        return {
          contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          collaborationId: cmd.collaboration.collaborationId,
          status: "provisioned",
          referralOutput: {
            affiliateId: "aff_001",
            referralCode: "aB3xQ1yZ",
            referralLink: "https://stay.example.com/hotel-slug?ref=aB3xQ1yZ",
            provisionedAt: "2026-06-07T10:00:01.000Z",
          },
        };
      },
    };

    const result = await fakePort.provisionAffiliate(command);

    expect(result.status).toBe("provisioned");
    expect(result.contractVersion).toBe(MARKETPLACE_AFFILIATE_CONTRACT_VERSION);
    expect(result.commandId).toBe("cmd_test_001");
    expect(result.collaborationId).toBe("collab_test_001");

    if (result.status === "provisioned" || result.status === "already_exists") {
      expect(result.referralOutput.referralCode).toBe("aB3xQ1yZ");
      expect(result.referralOutput.referralLink).toContain("aB3xQ1yZ");
    }
  });

  it("allows a failed provisioning result to carry an error without referralOutput", () => {
    const failedResult: AffiliateProvisioningResult = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_fail_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_fail_001:v1",
      collaborationId: "collab_fail_001",
      status: "failed",
      error: {
        code: "HOTEL_NOT_FOUND",
        retryable: false,
        sanitizedMessage: "No property found for the given hotel profile.",
      },
    };

    expect(failedResult.status).toBe("failed");
    // Type guard: referralOutput is undefined on failed results
    expect(failedResult.referralOutput).toBeUndefined();
    expect(failedResult.error.code).toBe("HOTEL_NOT_FOUND");
    expect(failedResult.error.retryable).toBe(false);
  });

  it("command must not carry PMS raw table references or cross-DB connection fields", () => {
    // NOTE: This is a structural documentation test, not runtime enforcement.
    // Runtime enforcement of the import boundary is handled by
    // scripts/check-architecture-boundaries.mjs (Marketplace domain check).
    // This test verifies that the ProvisionCollaborationAffiliateCommand type
    // contains no fields that would indicate cross-DB access. It passes as long
    // as the contract compiles without a pmsHotelId or PMS connection field.
    const command: ProvisionCollaborationAffiliateCommand = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_boundary_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_bnd_001:v1",
      audit: {
        requestId: "req_bnd",
        correlationId: "corr_bnd",
        organizationId: "org_hotel_bnd",
        creatorOrganizationId: "org_creator_bnd",
        actorType: "system",
        source: "job_retry",
        occurredAt: "2026-06-07T12:00:00.000Z",
      },
      collaboration: {
        collaborationId: "collab_bnd_001",
        status: "accepted",
        acceptedAt: "2026-06-07T12:00:00.000Z",
      },
      creator: {
        creatorId: "creator_bnd",
        creatorName: null,
        creatorEmail: null,
      },
      hotel: {
        // Only Marketplace-owned IDs — no pmsHotelId or raw DB reference
        marketplaceHotelProfileId: "mhp_bnd",
        organizationId: "org_hotel_bnd",
      },
      commissionTerms: {
        commissionPct: "5.00",
      },
    };

    expect(command.hotel).not.toHaveProperty("pmsHotelId");
    expect(command.hotel).not.toHaveProperty("pmsDatabase");
    expect(command.hotel.marketplaceHotelProfileId).toBe("mhp_bnd");
    expect(command.hotel.organizationId).toBe("org_hotel_bnd");

    // Compile-time guards: the type must not accept pmsHotelId or pmsDatabase.
    const _withPmsHotelId: ProvisionCollaborationAffiliateCommand = {
      ...command,
      // @ts-expect-error — pmsHotelId must not exist on AffiliateHotelReference
      hotel: { ...command.hotel, pmsHotelId: "pms_001" },
    };
    const _withPmsDatabase: ProvisionCollaborationAffiliateCommand = {
      ...command,
      // @ts-expect-error — pmsDatabase must not exist on AffiliateHotelReference
      hotel: { ...command.hotel, pmsDatabase: "pms_db_url" },
    };
    void _withPmsHotelId;
    void _withPmsDatabase;
  });

  it("buildAffiliateProvisioningCommandId derives a stable commandId from an idempotencyKey", () => {
    const idempotencyKey = buildAffiliateProvisioningIdempotencyKey({
      collaborationId: "collab_cmd_001",
    });
    const commandId = buildAffiliateProvisioningCommandId({ idempotencyKey });
    expect(commandId).toBe(`cmd:${idempotencyKey}`);
    // Calling again with the same idempotencyKey produces the same commandId
    expect(buildAffiliateProvisioningCommandId({ idempotencyKey })).toBe(commandId);
  });

  it("CollaborationAcceptedEvent does not carry referralOutput (immutable acceptance snapshot)", () => {
    // Domain events must be immutable snapshots. Provisioning output belongs on
    // AffiliateProvisionedEvent, not on the acceptance event.
    const accepted: CollaborationAcceptedEvent = {
      eventType: "marketplace.collaboration.accepted" as const,
      eventId: "evt_accepted_001",
      collaborationId: "collab_001",
      creatorId: "creator_001",
      marketplaceHotelProfileId: "mhp_001",
      organizationId: "org_001",
      acceptedAt: "2026-06-07T10:00:00.000Z",
      affiliateProvisioningRequested: true,
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "system" as const,
        source: "job_retry" as const,
        occurredAt: "2026-06-07T10:00:00.000Z",
      },
    };
    expect(accepted).not.toHaveProperty("referralOutput");
  });

  it("AffiliateProvisionedEvent carries referralOutput as an immutable provisioning snapshot", () => {
    const provisioned: AffiliateProvisionedEvent = {
      eventType: "marketplace.affiliate.provisioned",
      eventId: "evt_provisioned_001",
      causationId: "cmd:marketplace.affiliate.provision:collaboration:collab_001:v1",
      collaborationId: "collab_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_001:v1",
      referralOutput: {
        affiliateId: "aff_001",
        referralCode: "aB3xQ1yZ",
        referralLink: "https://stay.example.com/hotel?ref=aB3xQ1yZ",
        provisionedAt: "2026-06-07T10:00:01.000Z",
      },
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "system",
        source: "job_retry",
        occurredAt: "2026-06-07T10:00:01.000Z",
      },
    };
    expect(provisioned.referralOutput.referralCode).toBe("aB3xQ1yZ");
    expect(provisioned.eventType).toBe("marketplace.affiliate.provisioned");
  });
});
