import type pg from "pg";
import { AFFILIATE_TRACKING_PURPOSES, type AffiliateTrackingPurpose } from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import {
  AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
  type AffiliateDestinationTrackingReadiness,
  type AffiliateDestinationTrackingReadinessInput,
} from "./bookingAffiliateDestinationTrackingReadiness.js";
import type { AffiliatePublicationScope } from "./marketplaceAffiliatePublication.js";
import { createAffiliatePublicationPrerequisites } from "./marketplaceAffiliatePublicationPrerequisites.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const client = {} as pg.PoolClient;
const scope: AffiliatePublicationScope = {
  propertyId: id(3),
  organizationId: id(4),
  offerId: id(2),
  draftId: id(20),
  terms: {
    bookingDestinationId: id(30),
    financePolicyVersionId: id(10),
    attributionWindowDays: 14,
  },
};
const purposes = Object.fromEntries(
  AFFILIATE_TRACKING_PURPOSES.map((purpose) => [
    purpose,
    {
      certificationConnectionReference: `diagnostic:${purpose}`,
      productionConnectionReference: `production:${purpose}`,
      adapterVersion: `${purpose}-v1`,
    },
  ]),
) as AffiliateDestinationTrackingReadinessInput["purposes"];
const configuration = { certificationEnvironment: "sandbox" as const, purposes };
const evidence = AFFILIATE_TRACKING_PURPOSES.map((purpose, index) => ({
  purpose,
  evidenceReference:
    `booking:affiliate-destination-capability-readiness:${purpose}:` +
    `${id(100 + index)}:${id(200 + index)}`,
  validatedAt: new Date().toISOString(),
}));
const verified: AffiliateDestinationTrackingReadiness = {
  status: "verified",
  missing: [],
  policyVersion: AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
  evidence,
};

describe("affiliate publication prerequisite composition", () => {
  it("passes the exact destination and server configuration into tracking readiness", async () => {
    const trackingReadiness = vi.fn(async () => verified);
    const resolve = createAffiliatePublicationPrerequisites({
      commercialConditions: async () => ({
        status: "ready",
        conditionsText: "Complete creator-visible conditions",
        attributionPolicyVersion: "last-eligible-click.v1",
        evidenceReferences: ["commercial:1", evidence[0]!.evidenceReference],
      }),
      trackingConfiguration: async () => configuration,
      trackingReadiness,
    });

    await expect(resolve(client, scope)).resolves.toEqual({
      status: "ready",
      scope,
      conditionsText: "Complete creator-visible conditions",
      attributionPolicyVersion: "last-eligible-click.v1",
      evidenceReferences: ["commercial:1", ...evidence.map((item) => item.evidenceReference)],
    });
    expect(trackingReadiness).toHaveBeenCalledWith(client, {
      propertyId: scope.propertyId,
      destinationVersionId: scope.terms.bookingDestinationId,
      organizationId: scope.organizationId,
      ...configuration,
    });
  });

  it("reports absent server configuration alongside commercial blockers", async () => {
    const trackingReadiness = vi.fn();
    const resolve = createAffiliatePublicationPrerequisites({
      commercialConditions: async () => ({
        status: "blocked",
        reasons: ["commercial_conditions_unresolved"],
      }),
      trackingConfiguration: async () => undefined,
      trackingReadiness,
    });

    await expect(resolve(client, scope)).resolves.toEqual({
      status: "blocked",
      reasons: ["commercial_conditions_unresolved", "tracking_configuration_unavailable"],
    });
    expect(trackingReadiness).not.toHaveBeenCalled();
  });

  it("keeps each missing tracking purpose explicit and cannot publish partial evidence", async () => {
    const missing: AffiliateTrackingPurpose[] = ["stay_completion", "accommodation_revenue"];
    const resolve = createAffiliatePublicationPrerequisites({
      commercialConditions: async () => ({
        status: "ready",
        conditionsText: "Complete creator-visible conditions",
        attributionPolicyVersion: "last-eligible-click.v1",
        evidenceReferences: ["commercial:1"],
      }),
      trackingConfiguration: async () => configuration,
      trackingReadiness: async () => ({
        status: "pending",
        missing,
        policyVersion: AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
        evidence: evidence.slice(0, 2),
      }),
    });

    await expect(resolve(client, scope)).resolves.toEqual({
      status: "blocked",
      reasons: ["tracking_stay_completion_pending", "tracking_accommodation_revenue_pending"],
    });
  });

  it("fails closed when a readiness port claims verified without all four proofs", async () => {
    const resolve = createAffiliatePublicationPrerequisites({
      commercialConditions: async () => ({
        status: "ready",
        conditionsText: "Complete creator-visible conditions",
        attributionPolicyVersion: "last-eligible-click.v1",
        evidenceReferences: ["commercial:1"],
      }),
      trackingConfiguration: async () => configuration,
      trackingReadiness: async () => ({ ...verified, evidence: evidence.slice(0, 3) }),
    });

    await expect(resolve(client, scope)).resolves.toEqual({
      status: "blocked",
      reasons: ["tracking_readiness_invalid"],
    });
  });

  it.each([
    {
      name: "reused reference",
      evidence: evidence.map((item) => ({
        ...item,
        evidenceReference: evidence[0]!.evidenceReference,
      })),
    },
    {
      name: "invalid timestamp",
      evidence: evidence.map((item, index) =>
        index === 0 ? { ...item, validatedAt: "not-a-date" } : item,
      ),
    },
    {
      name: "wrong policy",
      policyVersion: "booking-affiliate-destination-tracking-readiness.v2",
      evidence,
    },
  ])("fails closed on $name", async ({ evidence: malformedEvidence, policyVersion }) => {
    const resolve = createAffiliatePublicationPrerequisites({
      commercialConditions: async () => ({
        status: "ready",
        conditionsText: "Complete creator-visible conditions",
        attributionPolicyVersion: "last-eligible-click.v1",
        evidenceReferences: ["commercial:1"],
      }),
      trackingConfiguration: async () => configuration,
      trackingReadiness: async () =>
        ({
          ...verified,
          ...(policyVersion ? { policyVersion } : {}),
          evidence: malformedEvidence,
        }) as AffiliateDestinationTrackingReadiness,
    });

    await expect(resolve(client, scope)).resolves.toEqual({
      status: "blocked",
      reasons: ["tracking_readiness_invalid"],
    });
  });

  it.each([null, {}, { status: "pending" }, { status: "verified", missing: null }])(
    "blocks a malformed readiness response %#",
    async (malformed) => {
      const resolve = createAffiliatePublicationPrerequisites({
        commercialConditions: async () => ({
          status: "ready",
          conditionsText: "Complete creator-visible conditions",
          attributionPolicyVersion: "last-eligible-click.v1",
          evidenceReferences: ["commercial:1"],
        }),
        trackingConfiguration: async () => configuration,
        trackingReadiness: async () =>
          malformed as unknown as AffiliateDestinationTrackingReadiness,
      });

      await expect(resolve(client, scope)).resolves.toEqual({
        status: "blocked",
        reasons: ["tracking_readiness_invalid"],
      });
    },
  );
});
