import { expect, it, vi } from "vitest";
import { createMarketplaceHotelCollaborationPreferencesEvidence } from "@vayada/domain-marketplace";
import { createMarketplaceSubmissionReadiness } from "./marketplaceSubmissionReadiness.js";
import type {
  MarketplaceCatalogSubmissionEvidence,
  MarketplaceCatalogSnapshot,
} from "./hotelCatalogMarketplaceSubmissionSource.js";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { propertyId, organizationId: "org", actorUserId: "actor" };
function harness(saved = true) {
  const source = {
    ownerDomain: "hotel_catalog" as const,
    entityType: "marketplace_submission_profile",
    entityId: propertyId,
    revision: "catalog:1:hash",
  };
  const evidence: MarketplaceCatalogSubmissionEvidence = {
    source,
    snapshot: { propertyId } as MarketplaceCatalogSnapshot,
    group: {
      groupId: "marketplace.hotel_profile",
      status: "ready",
      steps: [
        {
          owningStepId: "present_hotel",
          status: "ready",
          entities: [{ source, status: "ready", blockers: [] }],
        },
      ],
    },
  };
  const document = {
    compensationTypes: ["free_stay" as const],
    contentPlatforms: ["instagram" as const],
    contentTypes: ["post" as const],
    availability: { mode: "year_round" as const, selectedMonths: [] as [] },
  };
  const readModel = {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId,
    revision: saved ? 1 : 0,
    sourceRevision: saved ? "preferences:1" : "preferences:0",
    preferences: saved ? document : null,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
      propertyId,
      saved ? 1 : 0,
      saved ? document : null,
    ),
  };
  const catalog = { getSubmissionEvidence: vi.fn().mockResolvedValue(evidence) };
  const preferences = {
    getHotelCollaborationPreferences: vi
      .fn()
      .mockResolvedValue({ outcome: "available", readModel }),
  };
  return {
    service: createMarketplaceSubmissionReadiness({ catalog, preferences }),
    catalog,
    preferences,
    evidence,
    readModel,
  };
}
it("requires both Marketplace groups without Booking dependencies", async () => {
  const h = harness();
  const result = await h.service.evaluate(scope);
  expect(result.readiness.status).toBe("ready");
  expect(result.readiness.groups.map((group) => group.groupId)).toEqual([
    "marketplace.hotel_profile",
    "marketplace.collaboration_preferences",
  ]);
  expect(result.readiness.sourceManifest.sources).toHaveLength(2);
  expect(result.snapshot.preferencesRevision).toBe(1);
  expect(h.preferences.getHotelCollaborationPreferences).toHaveBeenCalledWith(scope);
});
it("distinguishes unselected preferences from a provider outage", async () => {
  const h = harness(false);
  const missing = await h.service.getReadiness(scope);
  expect(missing.status).toBe("blocked");
  if (missing.outcome === "evaluated")
    expect(missing.groups[1]?.steps[0]?.entities[0]?.blockers).toHaveLength(4);
  h.preferences.getHotelCollaborationPreferences.mockResolvedValue({ outcome: "unavailable" });
  const failed = await h.service.getReadiness(scope);
  expect(failed.outcome).toBe("provider_failure");
  expect(failed.status).toBe("error");
});
it("changes readiness identity after either owner revision changes", async () => {
  const h = harness();
  const before = await h.service.evaluate(scope);
  h.evidence.source.revision = "catalog:2:changed";
  const after = await h.service.evaluate(scope);
  expect(before.readiness.sourceManifestHash).not.toBe(after.readiness.sourceManifestHash);
  expect(before.readiness.readinessHash).not.toBe(after.readiness.readinessHash);
  h.readModel.revision = 2;
  h.readModel.sourceRevision = "preferences:2";
  h.readModel.readiness = createMarketplaceHotelCollaborationPreferencesEvidence(
    propertyId,
    2,
    h.readModel.preferences,
  );
  const changedPreferences = await h.service.evaluate(scope);
  expect(after.readiness.sourceManifestHash).not.toBe(
    changedPreferences.readiness.sourceManifestHash,
  );
  expect(after.readiness.readinessHash).not.toBe(changedPreferences.readiness.readinessHash);
});
it("rejects mismatched scopes and tampered preference evidence", async () => {
  const h = harness();
  h.readModel.propertyId = "33333333-3333-4333-8333-333333333333";
  await expect(h.service.evaluate(scope)).rejects.toThrow("unavailable");
  expect((await h.service.getReadiness(scope)).outcome).toBe("provider_failure");
});
it("preserves Catalog blockers and owning coordinates", async () => {
  const h = harness();
  const group = h.evidence.group;
  group.status = "blocked";
  group.steps[0]!.status = "blocked";
  group.steps[0]!.entities[0]!.status = "blocked";
  group.steps[0]!.entities[0]!.blockers = [
    {
      kind: "user_fixable",
      code: "logo_missing",
      message: "Add the property logo.",
      product: "marketplace",
      groupId: "marketplace.hotel_profile",
      owningStepId: "present_hotel",
      source: h.evidence.source,
    },
  ];
  const result = await h.service.evaluate(scope);
  expect(result.readiness.status).toBe("blocked");
  expect(result.readiness.groups[0]?.steps[0]?.entities[0]?.blockers[0]?.code).toBe("logo_missing");
});

it("normalizes uppercase UUID scope before reading or comparing owner identities", async () => {
  const h = harness();
  const result = await h.service.evaluate({ ...scope, propertyId: propertyId.toUpperCase() });
  expect(result.readiness.status).toBe("ready");
  expect(result.readiness.propertyId).toBe(propertyId);
  expect(h.catalog.getSubmissionEvidence).toHaveBeenCalledWith(scope);
  expect(h.preferences.getHotelCollaborationPreferences).toHaveBeenCalledWith(scope);
});
