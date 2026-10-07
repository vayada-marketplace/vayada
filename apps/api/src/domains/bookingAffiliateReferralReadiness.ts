import type pg from "pg";

export const AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS = 24 * 60 * 60;
export const AFFILIATE_REFERRAL_READINESS_POLICY_VERSION =
  "booking-affiliate-referral-readiness.v1";

type Scope = {
  propertyId: string;
  destinationVersionId: string;
  organizationId: string;
  certificationEnvironment: "local" | "sandbox";
  certificationConnectionReference: string;
  productionConnectionReference: string;
  adapterVersion: string;
};

export type AffiliateReferralRuntimeConfiguration = Pick<
  Scope,
  | "certificationEnvironment"
  | "certificationConnectionReference"
  | "productionConnectionReference"
  | "adapterVersion"
>;

export type AffiliateReferralReadiness =
  | {
      status: "ready";
      capability: "referral_round_trip";
      policyVersion: typeof AFFILIATE_REFERRAL_READINESS_POLICY_VERSION;
      evidenceReferences: string[];
      validatedAt: string;
    }
  | {
      status: "blocked";
      reasons: (
        | "destination_unavailable"
        | "diagnostic_certification_unavailable"
        | "production_preflight_unavailable"
      )[];
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;

export async function requireAffiliateReadinessTransaction(client: pg.PoolClient) {
  await client.query("SAVEPOINT affiliate_referral_readiness_transaction");
  const isolation = (await client.query("SHOW transaction_isolation")).rows[0]
    ?.transaction_isolation;
  await client.query("RELEASE SAVEPOINT affiliate_referral_readiness_transaction");
  if (isolation !== "read committed")
    throw new Error("Affiliate referral readiness requires a READ COMMITTED transaction");
}

/**
 * Selects the single current proof configuration for an exact destination.
 * Multiple candidates fail closed because the evidence tables do not declare
 * which connection supersedes another.
 */
export async function readAffiliateReferralRuntimeConfiguration(
  client: pg.PoolClient,
  scope: Pick<Scope, "propertyId" | "destinationVersionId" | "organizationId">,
): Promise<AffiliateReferralRuntimeConfiguration | undefined> {
  await requireAffiliateReadinessTransaction(client);
  if (
    !uuid.test(scope.propertyId) ||
    !uuid.test(scope.destinationVersionId) ||
    !uuid.test(scope.organizationId)
  )
    return undefined;
  const lockedScope = await client.query(
    `SELECT destination.id
     FROM booking.affiliate_destination_versions destination
     JOIN hotel_catalog.properties property ON property.id=destination.property_id
     WHERE destination.id=$1 AND destination.property_id=$2
       AND destination.created_by_organization_id=$3
     FOR SHARE OF destination,property`,
    [
      scope.destinationVersionId.toLowerCase(),
      scope.propertyId.toLowerCase(),
      scope.organizationId.toLowerCase(),
    ],
  );
  if (!lockedScope.rowCount) return undefined;
  const result = await client.query(
    `SELECT DISTINCT
       certification.environment AS "certificationEnvironment",
       certification.connection_reference AS "certificationConnectionReference",
       preflight.connection_reference AS "productionConnectionReference",
       certification.adapter_version AS "adapterVersion"
     FROM booking.affiliate_referral_transport_certifications certification
     JOIN booking.affiliate_validation_probes probe
       ON probe.id=certification.probe_id
      AND probe.property_id=certification.property_id
      AND probe.destination_version_id=certification.destination_version_id
      AND probe.organization_id=certification.organization_id
      AND probe.environment=certification.environment
      AND probe.connection_reference=certification.connection_reference
      AND probe.adapter_version=certification.adapter_version
     JOIN booking.affiliate_referral_production_preflights preflight
       ON preflight.property_id=certification.property_id
      AND preflight.destination_version_id=certification.destination_version_id
      AND preflight.organization_id=certification.organization_id
      AND preflight.adapter_version=certification.adapter_version
     WHERE certification.property_id=$1
       AND certification.destination_version_id=$2
       AND certification.organization_id=$3
       AND certification.completed_at >= clock_timestamp() - make_interval(secs => $4)
       AND preflight.completed_at >= clock_timestamp() - make_interval(secs => $4)
       AND NOT EXISTS (
         SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
         WHERE revoked.probe_id=probe.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM booking.affiliate_referral_production_preflight_revocations revoked
         WHERE revoked.preflight_id=preflight.id
       )
     LIMIT 2`,
    [
      scope.propertyId.toLowerCase(),
      scope.destinationVersionId.toLowerCase(),
      scope.organizationId.toLowerCase(),
      AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS,
    ],
  );
  return result.rows.length === 1
    ? (result.rows[0] as AffiliateReferralRuntimeConfiguration)
    : undefined;
}

/**
 * Reads the two independent Booking-owned proofs for referral transport readiness.
 * The caller must own an explicit READ COMMITTED transaction. Row locks serialize
 * revocation with final currentness checks; this never performs network I/O or writes.
 */
export async function readAffiliateReferralRoundTripReadiness(
  client: pg.PoolClient,
  input: Scope,
): Promise<AffiliateReferralReadiness> {
  await requireAffiliateReadinessTransaction(client);
  if (
    !uuid.test(input.propertyId) ||
    !uuid.test(input.destinationVersionId) ||
    !uuid.test(input.organizationId) ||
    !["local", "sandbox"].includes(input.certificationEnvironment) ||
    !bounded(input.certificationConnectionReference, 200) ||
    !bounded(input.productionConnectionReference, 200) ||
    !bounded(input.adapterVersion, 100)
  )
    return { status: "blocked", reasons: ["destination_unavailable"] };

  const scope = {
    propertyId: input.propertyId.toLowerCase(),
    destinationVersionId: input.destinationVersionId.toLowerCase(),
    organizationId: input.organizationId.toLowerCase(),
    certificationEnvironment: input.certificationEnvironment,
    certificationConnectionReference: input.certificationConnectionReference,
    productionConnectionReference: input.productionConnectionReference,
    adapterVersion: input.adapterVersion,
  };
  const destination = await client.query(
    `SELECT id FROM booking.affiliate_destination_versions
    WHERE id=$1 AND property_id=$2 AND created_by_organization_id=$3
    FOR SHARE`,
    [scope.destinationVersionId, scope.propertyId, scope.organizationId],
  );
  if (!destination.rowCount) return { status: "blocked", reasons: ["destination_unavailable"] };

  const reasons: Exclude<AffiliateReferralReadiness, { status: "ready" }>["reasons"] = [];
  const certification = await (async () => {
    for (;;) {
      const candidate = (
        await client.query(
          `SELECT certification.id,certification.probe_id,certification.completed_at
          FROM booking.affiliate_referral_transport_certifications certification
          JOIN booking.affiliate_validation_probes probe ON probe.id=certification.probe_id
            AND probe.property_id=certification.property_id
            AND probe.destination_version_id=certification.destination_version_id
            AND probe.organization_id=certification.organization_id
            AND probe.environment=certification.environment
            AND probe.connection_reference=certification.connection_reference
            AND probe.adapter_version=certification.adapter_version
          WHERE certification.property_id=$1 AND certification.destination_version_id=$2
            AND certification.organization_id=$3 AND certification.connection_reference=$4
            AND certification.adapter_version=$5 AND certification.environment=$6
            AND certification.capability='referral_round_trip'
            AND certification.validation_kind='adapter_certification'
            AND certification.evidence_scope='capability_validation'
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
            scope.certificationConnectionReference,
            scope.adapterVersion,
            scope.certificationEnvironment,
          ],
        )
      ).rows[0] as { id: string; probe_id: string; completed_at: Date } | undefined;
      if (!candidate) return undefined;
      const current = (
        await client.query(
          `SELECT certification.completed_at >= clock_timestamp() - make_interval(secs => $3) AS fresh,
              NOT EXISTS (
                SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
                WHERE revoked.probe_id=probe.id
              ) AS unrevoked
          FROM booking.affiliate_validation_probes probe
          JOIN booking.affiliate_referral_transport_certifications certification
            ON certification.id=$1 AND certification.probe_id=probe.id
          WHERE probe.id=$2`,
          [candidate.id, candidate.probe_id, AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS],
        )
      ).rows[0] as { fresh: boolean; unrevoked: boolean } | undefined;
      if (!current?.fresh) return undefined;
      if (current.unrevoked) return candidate;
    }
  })();
  if (!certification) reasons.push("diagnostic_certification_unavailable");

  const preflight = await (async () => {
    for (;;) {
      const candidate = (
        await client.query(
          `SELECT preflight.id,preflight.completed_at
          FROM booking.affiliate_referral_production_preflights preflight
          WHERE preflight.property_id=$1 AND preflight.destination_version_id=$2
            AND preflight.organization_id=$3 AND preflight.connection_reference=$4
            AND preflight.adapter_version=$5 AND preflight.environment='production'
            AND preflight.capability='referral_round_trip'
            AND preflight.validation_kind='production_preflight'
            AND preflight.evidence_scope='capability_validation'
            AND NOT EXISTS (
              SELECT 1 FROM booking.affiliate_referral_production_preflight_revocations revoked
              WHERE revoked.preflight_id=preflight.id
            )
          ORDER BY preflight.completed_at DESC,preflight.id DESC LIMIT 1
          FOR SHARE OF preflight`,
          [
            scope.propertyId,
            scope.destinationVersionId,
            scope.organizationId,
            scope.productionConnectionReference,
            scope.adapterVersion,
          ],
        )
      ).rows[0] as { id: string; completed_at: Date } | undefined;
      if (!candidate) return undefined;
      const current = (
        await client.query(
          `SELECT preflight.completed_at >= clock_timestamp() - make_interval(secs => $2) AS fresh,
              NOT EXISTS (
                SELECT 1 FROM booking.affiliate_referral_production_preflight_revocations revoked
                WHERE revoked.preflight_id=preflight.id
              ) AS unrevoked
          FROM booking.affiliate_referral_production_preflights preflight WHERE preflight.id=$1`,
          [candidate.id, AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS],
        )
      ).rows[0] as { fresh: boolean; unrevoked: boolean } | undefined;
      if (!current?.fresh) return undefined;
      if (current.unrevoked) return candidate;
    }
  })();
  if (!preflight) reasons.push("production_preflight_unavailable");

  if (reasons.length) return { status: "blocked", reasons };
  return {
    status: "ready",
    capability: "referral_round_trip",
    policyVersion: AFFILIATE_REFERRAL_READINESS_POLICY_VERSION,
    evidenceReferences: [
      `booking:affiliate-referral-transport-certification:${certification!.id}`,
      `booking:affiliate-referral-production-preflight:${preflight!.id}`,
    ],
    validatedAt: new Date(
      Math.min(certification!.completed_at.getTime(), preflight!.completed_at.getTime()),
    ).toISOString(),
  };
}
