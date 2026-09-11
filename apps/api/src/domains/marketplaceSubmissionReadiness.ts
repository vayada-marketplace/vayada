import {
  createProductReadinessResult,
  type ProductReadinessResult,
  type ReadinessGroupResult,
  type ReadinessProviderFailure,
} from "@vayada/domain-hotels";
import {
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  type MarketplaceHotelCollaborationPreferencesReadPort,
  type MarketplaceHotelCollaborationPreferences,
} from "@vayada/domain-marketplace";
import type { HotelCatalogStep1Scope } from "./hotelCatalogStep1Repository.js";
import type {
  MarketplaceCatalogSnapshot,
  MarketplaceCatalogSubmissionSource,
} from "./hotelCatalogMarketplaceSubmissionSource.js";

export type MarketplaceSubmissionSnapshot = {
  contractVersion: "marketplace-submission-snapshot.v1";
  catalog: MarketplaceCatalogSnapshot;
  preferences: MarketplaceHotelCollaborationPreferences | null;
  preferencesRevision: number;
};
export type MarketplaceSubmissionEvaluation = {
  readiness: ProductReadinessResult;
  snapshot: MarketplaceSubmissionSnapshot;
};
export type MarketplaceSubmissionReadinessPort = {
  evaluate(scope: HotelCatalogStep1Scope): Promise<MarketplaceSubmissionEvaluation>;
  getReadiness(
    scope: HotelCatalogStep1Scope,
  ): Promise<ProductReadinessResult | ReadinessProviderFailure>;
};
export function createMarketplaceSubmissionReadiness(config: {
  catalog: MarketplaceCatalogSubmissionSource;
  preferences: MarketplaceHotelCollaborationPreferencesReadPort;
  now?: () => Date;
}): MarketplaceSubmissionReadinessPort {
  const now = config.now ?? (() => new Date());
  async function evaluate(scope: HotelCatalogStep1Scope): Promise<MarketplaceSubmissionEvaluation> {
    // Keep Catalog before Marketplace so transaction-backed providers share one lock order.
    const catalog = await config.catalog.getSubmissionEvidence(scope);
    const result = await config.preferences.getHotelCollaborationPreferences(scope);
    const preferences =
      result.outcome === "available"
        ? parseMarketplaceHotelCollaborationPreferencesReadModel(result.readModel)
        : null;
    if (
      !preferences ||
      preferences.propertyId !== scope.propertyId ||
      catalog.snapshot.propertyId !== scope.propertyId ||
      catalog.source.entityId !== scope.propertyId
    )
      throw new Error("Marketplace submission sources are unavailable.");
    const evidence = preferences.readiness;
    const group: ReadinessGroupResult = {
      groupId: evidence.groupId,
      status: evidence.status,
      steps: [
        {
          owningStepId: evidence.owningStepId,
          status: evidence.status,
          entities: [
            {
              source: evidence.source,
              status: evidence.status,
              blockers: evidence.omissions.map((omission) => ({
                ...omission,
                product: evidence.product,
                groupId: evidence.groupId,
                owningStepId: evidence.owningStepId,
                source: evidence.source,
              })),
            },
          ],
        },
      ],
    };
    const groups = [catalog.group, group];
    const status = groups.some((value) => value.status === "error")
      ? "error"
      : groups.some((value) => value.status === "blocked")
        ? "blocked"
        : groups.some((value) => value.status === "pending")
          ? "pending"
          : "ready";
    const readiness = await createProductReadinessResult({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId: scope.propertyId,
      product: "marketplace",
      status,
      sourceManifest: {
        contractVersion: "onboarding-source-manifest.v1",
        propertyId: scope.propertyId,
        sources: [catalog.source, evidence.source],
      },
      groups,
      evaluatedAt: now().toISOString(),
    });
    return {
      readiness,
      snapshot: {
        contractVersion: "marketplace-submission-snapshot.v1",
        catalog: catalog.snapshot,
        preferences: preferences.preferences,
        preferencesRevision: preferences.revision,
      },
    };
  }
  return {
    evaluate,
    async getReadiness(scope) {
      try {
        return (await evaluate(scope)).readiness;
      } catch {
        return {
          outcome: "provider_failure",
          contractVersion: "onboarding-product-readiness.v1",
          propertyId: scope.propertyId,
          product: "marketplace",
          status: "error",
          evaluatedAt: now().toISOString(),
          error: {
            kind: "system_error",
            errorSource: "provider",
            code: "marketplace_readiness_unavailable",
            message: "Marketplace readiness is temporarily unavailable. Try again.",
            retryable: true,
          },
        };
      }
    },
  };
}
