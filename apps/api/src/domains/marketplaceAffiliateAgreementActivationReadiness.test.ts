import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createAffiliateAgreementActivationReadiness } from "./marketplaceAffiliateAgreementActivationReadiness.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const scope = {
  propertyId: id(1),
  hotelOrganizationId: id(2),
  offerId: id(3),
  programId: id(4),
  participationId: id(5),
  attemptId: id(6),
  termsId: id(7),
  creatorProfileId: id(8),
  creatorOrganizationId: id(9),
};
const row = {
  source_draft_id: id(10),
  attribution_policy_version: "last-eligible-click.v1",
  disclosure: JSON.stringify({
    terms: {
      bookingDestinationId: id(11),
      financePolicyVersionId: id(12),
      attributionWindowDays: 30,
    },
    conditionsText: "exact creator-visible conditions",
  }),
};

describe("affiliate agreement activation readiness", () => {
  it("rechecks the exact open terms through the publication prerequisites", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({
          rows: [
            {
              destinationVersionId: id(11),
              display_name: "Direct booking",
              booking_url: "https://hotel.example/book",
              createdAt: new Date(),
            },
          ],
        }),
    } as unknown as pg.PoolClient;
    const publicationScope = {
      propertyId: scope.propertyId,
      organizationId: scope.hotelOrganizationId,
      offerId: scope.offerId,
      draftId: row.source_draft_id,
      terms: {
        bookingDestinationId: id(11),
        financePolicyVersionId: id(12),
        attributionWindowDays: 30,
      },
    };
    const prerequisites = vi.fn().mockResolvedValue({
      status: "ready",
      scope: publicationScope,
      conditionsText: "exact creator-visible conditions",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: ["fresh-finance-and-booking-proof"],
    });

    await expect(
      createAffiliateAgreementActivationReadiness(prerequisites)(client, scope),
    ).resolves.toEqual({
      status: "ready",
      scope,
      enrollmentOpen: true,
      evidenceReferences: ["fresh-finance-and-booking-proof"],
    });
    expect(client.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR SHARE OF terms"), [
      scope.termsId,
      scope.programId,
      scope.offerId,
      scope.propertyId,
      scope.hotelOrganizationId,
    ]);
    expect(prerequisites).toHaveBeenCalledWith(client, publicationScope);
  });

  it("blocks a superseded or invalid published version before owner-domain reads", async () => {
    const prerequisites = vi.fn();
    for (const rows of [[], [{ ...row, disclosure: "not json" }]]) {
      const client = { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.PoolClient;
      await expect(
        createAffiliateAgreementActivationReadiness(prerequisites)(client, scope),
      ).resolves.toEqual({
        status: "blocked",
        reasons: [rows.length ? "published_terms_invalid" : "enrollment_closed"],
      });
    }
    expect(prerequisites).not.toHaveBeenCalled();
  });

  it("does not activate when current commercial conditions differ from accepted terms", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({
          rows: [
            {
              destinationVersionId: id(11),
              display_name: "Direct booking",
              booking_url: "https://hotel.example/book",
              createdAt: new Date(),
            },
          ],
        }),
    } as unknown as pg.PoolClient;
    const prerequisites = vi.fn().mockResolvedValue({
      status: "ready",
      scope: {
        propertyId: scope.propertyId,
        organizationId: scope.hotelOrganizationId,
        offerId: scope.offerId,
        draftId: row.source_draft_id,
        terms: {
          bookingDestinationId: id(11),
          financePolicyVersionId: id(12),
          attributionWindowDays: 30,
        },
      },
      conditionsText: "changed conditions",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: ["fresh-proof"],
    });
    await expect(
      createAffiliateAgreementActivationReadiness(prerequisites)(client, scope),
    ).resolves.toEqual({ status: "blocked", reasons: ["published_conditions_changed"] });
  });

  it("blocks a disabled property's missing destination before owner-domain reads", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as pg.PoolClient;
    const prerequisites = vi.fn();
    await expect(
      createAffiliateAgreementActivationReadiness(prerequisites)(client, scope),
    ).resolves.toEqual({ status: "blocked", reasons: ["destination_unavailable"] });
    expect(prerequisites).not.toHaveBeenCalled();
  });

  it("rejects owner-domain proof for a different publication scope", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({
          rows: [
            {
              destinationVersionId: id(11),
              display_name: "Direct booking",
              booking_url: "https://hotel.example/book",
              createdAt: new Date(),
            },
          ],
        }),
    } as unknown as pg.PoolClient;
    const prerequisites = vi.fn().mockResolvedValue({
      status: "ready",
      scope: {
        propertyId: id(999),
        organizationId: scope.hotelOrganizationId,
        offerId: scope.offerId,
        draftId: row.source_draft_id,
        terms: {
          bookingDestinationId: id(11),
          financePolicyVersionId: id(12),
          attributionWindowDays: 30,
        },
      },
      conditionsText: "exact creator-visible conditions",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: ["wrong-scope-proof"],
    });
    await expect(
      createAffiliateAgreementActivationReadiness(prerequisites)(client, scope),
    ).rejects.toThrow("Invalid activation prerequisite proof");
  });
});
