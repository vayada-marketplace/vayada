import type pg from "pg";
import { AFFILIATE_TRACKING_PURPOSES, type AffiliateTrackingPurpose } from "@vayada/domain-booking";

import {
  AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
  isVerifiedAffiliateDestinationTrackingReadiness,
  readAffiliateDestinationTrackingReadiness,
  type AffiliateDestinationTrackingConfigurationPort,
  type AffiliateDestinationTrackingReadinessPort,
} from "./bookingAffiliateDestinationTrackingReadiness.js";
import type {
  AffiliatePublicationPrerequisites,
  AffiliatePublicationScope,
} from "./marketplaceAffiliatePublication.js";

type CommercialConditions =
  | {
      status: "ready";
      conditionsText: string;
      attributionPolicyVersion: string;
      evidenceReferences: string[];
    }
  | { status: "blocked"; reasons: string[] };

export type AffiliatePublicationCommercialConditionsPort = (
  client: pg.PoolClient,
  scope: AffiliatePublicationScope,
) => Promise<CommercialConditions>;

const pendingReason = (purpose: AffiliateTrackingPurpose) => `tracking_${purpose}_pending`;

function pendingPurposes(value: unknown): AffiliateTrackingPurpose[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as { status?: unknown; policyVersion?: unknown; missing?: unknown };
  const reportedMissing = result.missing;
  if (
    result.status !== "pending" ||
    result.policyVersion !== AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION ||
    !Array.isArray(reportedMissing) ||
    reportedMissing.length === 0
  )
    return undefined;
  const missing = AFFILIATE_TRACKING_PURPOSES.filter((purpose) =>
    reportedMissing.includes(purpose),
  );
  return missing.length === reportedMissing.length ? missing : undefined;
}

/**
 * Combines owner-domain commercial conditions with Booking-owned tracking evidence
 * inside the publication command's READ COMMITTED transaction. Ports must perform
 * transaction-local reads only; request data and provider network responses are not
 * valid configuration or proof.
 */
export function createAffiliatePublicationPrerequisites(config: {
  commercialConditions: AffiliatePublicationCommercialConditionsPort;
  trackingConfiguration: AffiliateDestinationTrackingConfigurationPort;
  trackingReadiness?: AffiliateDestinationTrackingReadinessPort;
}): AffiliatePublicationPrerequisites {
  const readTracking = config.trackingReadiness ?? readAffiliateDestinationTrackingReadiness;
  return async (client, scope) => {
    const conditions = await config.commercialConditions(client, structuredClone(scope));
    const trackingScope = {
      propertyId: scope.propertyId,
      destinationVersionId: scope.terms.bookingDestinationId,
      organizationId: scope.organizationId,
    };
    const trackingConfiguration = await config.trackingConfiguration(client, trackingScope);
    const reasons = conditions.status === "blocked" ? [...conditions.reasons] : [];
    if (!trackingConfiguration) {
      reasons.push("tracking_configuration_unavailable");
      return { status: "blocked", reasons: [...new Set(reasons)] };
    }

    const tracking: unknown = await readTracking(client, {
      ...trackingScope,
      ...trackingConfiguration,
    });
    const completeTracking = isVerifiedAffiliateDestinationTrackingReadiness(tracking);
    const missing = completeTracking ? [] : pendingPurposes(tracking);
    if (missing) reasons.push(...missing.map(pendingReason));
    else if (!completeTracking) reasons.push("tracking_readiness_invalid");
    if (conditions.status === "blocked" || !completeTracking)
      return { status: "blocked", reasons: [...new Set(reasons)] };

    return {
      status: "ready",
      scope,
      conditionsText: conditions.conditionsText,
      attributionPolicyVersion: conditions.attributionPolicyVersion,
      evidenceReferences: [
        ...new Set([
          ...conditions.evidenceReferences,
          ...tracking.evidence.map(({ evidenceReference }) => evidenceReference),
        ]),
      ],
    };
  };
}
