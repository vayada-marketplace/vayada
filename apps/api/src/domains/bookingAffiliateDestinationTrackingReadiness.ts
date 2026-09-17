import type pg from "pg";
import {
  AFFILIATE_TRACKING_PURPOSES,
  assessAffiliateDestinationTracking,
  type AffiliateDestinationTrackingEvidence,
  type AffiliateTrackingPurpose,
} from "@vayada/domain-booking";
import {
  AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS,
  readAffiliateReferralRoundTripReadiness,
  requireAffiliateReadinessTransaction,
} from "./bookingAffiliateReferralReadiness.js";
import {
  affiliateSourceCapabilities,
  type AffiliateSourceCapability,
} from "./bookingAffiliateSourceCapabilityProductionPreflight.js";

export const AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION =
  "booking-affiliate-destination-tracking-readiness.v1";

export type AffiliateDestinationTrackingPurposeConfiguration = {
  certificationConnectionReference: string;
  productionConnectionReference: string;
  adapterVersion: string;
};

export type AffiliateDestinationTrackingReadinessInput = {
  propertyId: string;
  destinationVersionId: string;
  organizationId: string;
  certificationEnvironment: "local" | "sandbox";
  purposes: Record<AffiliateTrackingPurpose, AffiliateDestinationTrackingPurposeConfiguration>;
};

export type AffiliateDestinationTrackingScope = Pick<
  AffiliateDestinationTrackingReadinessInput,
  "propertyId" | "destinationVersionId" | "organizationId"
>;

export type AffiliateDestinationTrackingConfigurationPort = (
  client: pg.PoolClient,
  scope: AffiliateDestinationTrackingScope,
) => Promise<
  | Pick<AffiliateDestinationTrackingReadinessInput, "certificationEnvironment" | "purposes">
  | undefined
>;

type ReadyPurpose = {
  purpose: AffiliateTrackingPurpose;
  evidenceReference: string;
  validatedAt: string;
};

export type AffiliateDestinationTrackingReadiness = {
  status: "verified" | "pending";
  missing: AffiliateTrackingPurpose[];
  policyVersion: typeof AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION;
  evidence: ReadyPurpose[];
};

export type AffiliateDestinationTrackingReadinessPort = (
  client: pg.PoolClient,
  input: AffiliateDestinationTrackingReadinessInput,
) => Promise<AffiliateDestinationTrackingReadiness>;

const combinedReferencePattern = (purpose: AffiliateTrackingPurpose) =>
  new RegExp(
    `^booking:affiliate-destination-capability-readiness:${purpose}:` +
      "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:" +
      "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    "i",
  );

/** Fails closed when a trusted port violates the aggregate reader's runtime contract. */
export function isVerifiedAffiliateDestinationTrackingReadiness(
  value: unknown,
  now = new Date(),
): value is AffiliateDestinationTrackingReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<AffiliateDestinationTrackingReadiness>;
  if (
    result.status !== "verified" ||
    result.policyVersion !== AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION ||
    !Array.isArray(result.missing) ||
    result.missing.length !== 0 ||
    !Array.isArray(result.evidence) ||
    result.evidence.length !== AFFILIATE_TRACKING_PURPOSES.length ||
    !Number.isFinite(now.getTime())
  )
    return false;
  const references = new Set<string>();
  return AFFILIATE_TRACKING_PURPOSES.every((purpose) => {
    const items = result.evidence!.filter((item) => item?.purpose === purpose);
    if (items.length !== 1) return false;
    const item = items[0]!;
    if (typeof item.evidenceReference !== "string" || typeof item.validatedAt !== "string")
      return false;
    const validatedAt = Date.parse(item.validatedAt);
    if (
      !combinedReferencePattern(purpose).test(item.evidenceReference) ||
      !Number.isFinite(validatedAt) ||
      validatedAt > now.getTime() ||
      validatedAt < now.getTime() - AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS * 1_000 ||
      references.has(item.evidenceReference)
    )
      return false;
    references.add(item.evidenceReference);
    return true;
  });
}

type CurrentProof = { id: string; completed_at: Date };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const validConfiguration = (value: AffiliateDestinationTrackingPurposeConfiguration) =>
  bounded(value?.certificationConnectionReference, 200) &&
  bounded(value?.productionConnectionReference, 200) &&
  bounded(value?.adapterVersion, 100);

async function currentCertification(
  client: pg.PoolClient,
  scope: Omit<AffiliateDestinationTrackingReadinessInput, "purposes">,
  capability: AffiliateSourceCapability,
  configuration: AffiliateDestinationTrackingPurposeConfiguration,
): Promise<CurrentProof | undefined> {
  for (;;) {
    const candidate = (
      await client.query(
        `SELECT certification.id,certification.probe_id,certification.completed_at
        FROM booking.affiliate_source_capability_certifications certification
        JOIN booking.affiliate_validation_probes probe ON probe.id=certification.probe_id
          AND probe.property_id=certification.property_id
          AND probe.destination_version_id=certification.destination_version_id
          AND probe.organization_id=certification.organization_id
          AND probe.environment=certification.environment
          AND probe.connection_reference=certification.connection_reference
          AND probe.adapter_version=certification.adapter_version
        WHERE certification.property_id=$1 AND certification.destination_version_id=$2
          AND certification.organization_id=$3 AND certification.environment=$4
          AND certification.connection_reference=$5 AND certification.adapter_version=$6
          AND certification.capability=$7 AND certification.validation_kind='adapter_certification'
          AND certification.evidence_scope='capability_validation'
          AND certification.validation_method='isolated_synthetic_fixture'
          AND certification.contract_version=
            'booking-affiliate-source-capability-certification.v1'
          AND NOT EXISTS (
            SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
            WHERE revoked.probe_id=probe.id
          )
        ORDER BY certification.completed_at DESC,certification.id DESC LIMIT 1
        FOR SHARE OF certification,probe`,
        [
          scope.propertyId,
          scope.destinationVersionId,
          scope.organizationId,
          scope.certificationEnvironment,
          configuration.certificationConnectionReference,
          configuration.adapterVersion,
          capability,
        ],
      )
    ).rows[0] as (CurrentProof & { probe_id: string }) | undefined;
    if (!candidate) return undefined;
    const current = (
      await client.query(
        `SELECT certification.completed_at >= clock_timestamp() - make_interval(secs => $3)
            AS fresh,
          NOT EXISTS (
            SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
            WHERE revoked.probe_id=probe.id
          ) AS unrevoked
        FROM booking.affiliate_validation_probes probe
        JOIN booking.affiliate_source_capability_certifications certification
          ON certification.id=$1 AND certification.probe_id=probe.id
        WHERE probe.id=$2`,
        [candidate.id, candidate.probe_id, AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS],
      )
    ).rows[0] as { fresh: boolean; unrevoked: boolean } | undefined;
    if (!current?.fresh) return undefined;
    if (current.unrevoked) return candidate;
  }
}

async function currentPreflight(
  client: pg.PoolClient,
  scope: Pick<
    AffiliateDestinationTrackingReadinessInput,
    "propertyId" | "destinationVersionId" | "organizationId"
  >,
  capability: AffiliateSourceCapability,
  configuration: AffiliateDestinationTrackingPurposeConfiguration,
): Promise<CurrentProof | undefined> {
  for (;;) {
    const candidate = (
      await client.query(
        `SELECT preflight.id,preflight.completed_at
        FROM booking.affiliate_source_capability_production_preflights preflight
        WHERE preflight.property_id=$1 AND preflight.destination_version_id=$2
          AND preflight.organization_id=$3 AND preflight.environment='production'
          AND preflight.connection_reference=$4 AND preflight.adapter_version=$5
          AND preflight.capability=$6 AND preflight.validation_kind='production_preflight'
          AND preflight.evidence_scope='capability_validation'
          AND preflight.preflight_method='documented_authenticated_read'
          AND preflight.contract_version=
            'booking-affiliate-source-capability-production-preflight.v1'
          AND NOT EXISTS (
            SELECT 1 FROM booking.affiliate_source_capability_preflight_revocations revoked
            WHERE revoked.preflight_id=preflight.id
          )
        ORDER BY preflight.completed_at DESC,preflight.id DESC LIMIT 1
        FOR SHARE OF preflight`,
        [
          scope.propertyId,
          scope.destinationVersionId,
          scope.organizationId,
          configuration.productionConnectionReference,
          configuration.adapterVersion,
          capability,
        ],
      )
    ).rows[0] as CurrentProof | undefined;
    if (!candidate) return undefined;
    const current = (
      await client.query(
        `SELECT preflight.completed_at >= clock_timestamp() - make_interval(secs => $2)
            AS fresh,
          NOT EXISTS (
            SELECT 1 FROM booking.affiliate_source_capability_preflight_revocations revoked
            WHERE revoked.preflight_id=preflight.id
          ) AS unrevoked
        FROM booking.affiliate_source_capability_production_preflights preflight
        WHERE preflight.id=$1`,
        [candidate.id, AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS],
      )
    ).rows[0] as { fresh: boolean; unrevoked: boolean } | undefined;
    if (!current?.fresh) return undefined;
    if (current.unrevoked) return candidate;
  }
}

const combinedReference = (
  purpose: AffiliateTrackingPurpose,
  certificationId: string,
  preflightId: string,
) =>
  `booking:affiliate-destination-capability-readiness:${purpose}:${certificationId}:${preflightId}`;

/**
 * Rechecks both current proofs for all four tracking purposes and applies the
 * existing domain assessment. The caller owns a READ COMMITTED transaction.
 */
export async function readAffiliateDestinationTrackingReadiness(
  client: pg.PoolClient,
  input: AffiliateDestinationTrackingReadinessInput,
): Promise<AffiliateDestinationTrackingReadiness> {
  await requireAffiliateReadinessTransaction(client);
  const validScope =
    uuid.test(input.propertyId) &&
    uuid.test(input.destinationVersionId) &&
    uuid.test(input.organizationId) &&
    ["local", "sandbox"].includes(input.certificationEnvironment);
  const scope = {
    propertyId: input.propertyId.toLowerCase(),
    destinationVersionId: input.destinationVersionId.toLowerCase(),
    organizationId: input.organizationId.toLowerCase(),
    certificationEnvironment: input.certificationEnvironment,
  };
  const evidence: AffiliateDestinationTrackingEvidence[] = [];
  if (validScope) {
    const destination = await client.query(
      `SELECT id FROM booking.affiliate_destination_versions
      WHERE id=$1 AND property_id=$2 AND created_by_organization_id=$3
      FOR SHARE`,
      [scope.destinationVersionId, scope.propertyId, scope.organizationId],
    );
    if (destination.rowCount) {
      const referralConfiguration = input.purposes.referral_round_trip;
      if (validConfiguration(referralConfiguration)) {
        const referral = await readAffiliateReferralRoundTripReadiness(client, {
          ...scope,
          certificationConnectionReference: referralConfiguration.certificationConnectionReference,
          productionConnectionReference: referralConfiguration.productionConnectionReference,
          adapterVersion: referralConfiguration.adapterVersion,
        });
        if (referral.status === "ready")
          evidence.push({
            destinationVersionId: scope.destinationVersionId,
            propertyId: scope.propertyId,
            connectionId: referralConfiguration.productionConnectionReference,
            connectionStatus: "active",
            purpose: "referral_round_trip",
            support: "supported",
            validation: "validated",
            evidenceReference: combinedReference(
              "referral_round_trip",
              referral.evidenceReferences[0]!.split(":").at(-1)!,
              referral.evidenceReferences[1]!.split(":").at(-1)!,
            ),
            validatedAt: referral.validatedAt,
            health: "healthy",
          });
      }

      for (const capability of affiliateSourceCapabilities) {
        const configuration = input.purposes[capability];
        if (!validConfiguration(configuration)) continue;
        const certification = await currentCertification(client, scope, capability, configuration);
        const preflight = await currentPreflight(client, scope, capability, configuration);
        if (!certification || !preflight) continue;
        evidence.push({
          destinationVersionId: scope.destinationVersionId,
          propertyId: scope.propertyId,
          connectionId: configuration.productionConnectionReference,
          connectionStatus: "active",
          purpose: capability,
          support: "supported",
          validation: "validated",
          evidenceReference: combinedReference(capability, certification.id, preflight.id),
          validatedAt: new Date(
            Math.min(certification.completed_at.getTime(), preflight.completed_at.getTime()),
          ).toISOString(),
          health: "healthy",
        });
      }
    }
  }

  const assessment = assessAffiliateDestinationTracking(
    {
      destinationVersionId: scope.destinationVersionId,
      propertyId: scope.propertyId,
      enabled: validScope,
    },
    evidence,
    new Date(),
  );
  return {
    ...assessment,
    policyVersion: AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
    evidence: evidence.map(({ purpose, evidenceReference, validatedAt }) => ({
      purpose,
      evidenceReference: evidenceReference!,
      validatedAt: validatedAt!,
    })),
  };
}
