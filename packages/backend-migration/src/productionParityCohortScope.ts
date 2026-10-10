import { createHash } from "node:crypto";

import type pg from "pg";

import { readProductionMigrationCohort } from "./productionMigrationCohort.js";
import type { ProductionParityFinding } from "./productionParity.js";

// VAY-1362 COHORT_SCOPE_VERIFIED (engineering/legacy-migration-cohort-scope.md, "Verification").
// Each violation category with the message its finding carries.
const MESSAGES = {
  cohortHotelUnresolved: "A cohort hotel does not resolve to exactly one target property",
  cohortPropertyQuarantined: "A cohort hotel resolves to a private-quarantine property",
  cohortPropertyOwner:
    "A cohort property lacks exactly one active hotel organization with both native owner links",
  cohortPropertyEntitlement:
    "A cohort property's organization lacks an active, unsuspended PMS property entitlement",
  profileNotPrivate: "A property outside the cohort has a non-private profile",
  verifiedDomain: "A property outside the cohort has a verified custom domain",
  publicMedia: "A property outside the cohort has public media",
  publicOffers: "A property outside the cohort has an active promo or public bookable offer",
  publicAddons: "A property outside the cohort has a public add-on",
  marketplaceListing: "A property outside the cohort has a creator-visible Marketplace listing",
  activeOwnerLink: "A property outside the cohort has an active organization resource link",
  activeMembership:
    "An active membership reaches a property outside the cohort via an unarchived link",
  activeEntitlement: "A property outside the cohort has an active, unexpired entitlement",
  connectedChannel: "A property outside the cohort has a connected or degraded channel connection",
  activeChannexMapping: "A property outside the cohort has an active Channex mapping",
  bindingClaim: "A property outside the cohort holds a Channex binding claim",
  enabledProviderAccount:
    "A property outside the cohort can take payments or has an enabled account",
  actionablePayout:
    "A property outside the cohort has a pending, scheduled, processing or failed payout",
} as const;
export type CohortScopeCategory = keyof typeof MESSAGES;
export const COHORT_SCOPE_CATEGORIES = Object.keys(MESSAGES) as CohortScopeCategory[];

/** Stored cohort plus every scope violation; subjects are raw IDs, hashed before reporting. */
export type ProductionParityCohortScopeEvidence = {
  cohortSha256: string;
  approvalProofSha256: string;
  cohortProperties: number;
  nonCohortProperties: number;
  violations: Array<{ category: CohortScopeCategory; subjectId: string }>;
};

export type ProductionParityCohortScopeSummary = {
  cohortProperties: number;
  nonCohortProperties: number;
  violations: Record<CohortScopeCategory, number>;
};

type QueryClient = Pick<pg.ClientBase, "query">;

// Outside the cohort is decided from the three ID sets (like outsideCohortSource), never from
// the catalog quarantine reason. $1/$2/$3: Booking, PMS and Marketplace cohort hotel IDs.
// Links are not filtered by run: STALE_MIGRATION_PROVENANCE already fails links of other runs.
const SCOPE_CTES = `
  WITH legacy_link AS (
    SELECT link.property_id, lower(link.source_id) AS source_id, link.source_system,
           link.metadata ->> 'migrationDisposition' AS disposition,
           lower(link.source_id) = ANY (CASE link.source_system
             WHEN 'booking' THEN $1::text[] WHEN 'pms' THEN $2::text[] ELSE $3::text[] END) AS inside
      FROM hotel_catalog.property_source_links link
     WHERE link.status = 'active'
       AND ((link.source_system = 'booking' AND link.source_table = 'booking_hotels')
         OR (link.source_system = 'pms' AND link.source_table = 'hotels')
         OR (link.source_system = 'marketplace' AND link.source_table = 'hotel_profiles'))
  ), outside AS (
    SELECT DISTINCT property_id FROM legacy_link WHERE NOT inside
  ), outside_resource AS (
    SELECT property_id, property_id::text AS resource_id FROM outside
    UNION
    SELECT link.property_id, link.source_id FROM legacy_link link JOIN outside USING (property_id)
    UNION
    SELECT offer.property_id, offer.id::text FROM marketplace.marketplace_offers offer
      JOIN outside USING (property_id)
  ), owner_link AS (
    SELECT resource.property_id, link.organization_id, link.status
      FROM outside_resource resource
      JOIN identity.organization_resource_links link ON lower(link.resource_id) = resource.resource_id
     WHERE link.status <> 'archived'
       AND link.resource_type IN ('property', 'booking_hotel', 'pms_hotel', 'pms_property',
                                  'hotel_profile', 'marketplace_offer')
  ), cohort_hotel AS (
    SELECT 'booking' AS source_system, id FROM unnest($1::text[]) AS id
    UNION ALL SELECT 'pms', id FROM unnest($2::text[]) AS id
    UNION ALL SELECT 'marketplace', id FROM unnest($3::text[]) AS id
  ), cohort_resolution AS (
    SELECT hotel.id, count(property.id) AS properties,
           bool_or(link.disposition = 'private_quarantine') AS quarantined
      FROM cohort_hotel hotel
      LEFT JOIN legacy_link link
        ON link.source_system = hotel.source_system AND link.source_id = hotel.id
      LEFT JOIN hotel_catalog.properties property ON property.id = link.property_id
     GROUP BY hotel.source_system, hotel.id
  ), cohort_owner AS (
    -- VAY-1543 runtime tenancy: both links active with owner/operator, in the same organization.
    SELECT DISTINCT cohort.property_id, catalog.organization_id
      FROM (SELECT DISTINCT property_id FROM legacy_link WHERE inside) cohort
      JOIN identity.organization_resource_links catalog
        ON catalog.product = 'hotel_catalog' AND catalog.resource_type = 'property'
       AND catalog.resource_id = cohort.property_id::text
      JOIN identity.organization_resource_links pms
        ON pms.organization_id = catalog.organization_id AND pms.product = 'pms'
       AND pms.resource_type = 'pms_property' AND pms.resource_id = catalog.resource_id
     WHERE catalog.status = 'active' AND pms.status = 'active'
       AND catalog.relationship IN ('owner', 'operator') AND pms.relationship IN ('owner', 'operator')
  )`;

const SCOPE_COUNT_QUERY = `${SCOPE_CTES}
  SELECT (SELECT count(DISTINCT link.property_id) FROM legacy_link link
           JOIN hotel_catalog.properties property ON property.id = link.property_id
          WHERE link.inside)::text AS "cohortProperties",
         (SELECT count(*) FROM outside)::text AS "nonCohortProperties"`;

const SCOPE_VIOLATION_QUERY = `${SCOPE_CTES}
  SELECT DISTINCT category, subject_id::text AS "subjectId" FROM (
    SELECT 'cohortHotelUnresolved' AS category, id AS subject_id
      FROM cohort_resolution WHERE properties <> 1
    UNION ALL SELECT 'cohortPropertyQuarantined', id FROM cohort_resolution
     WHERE properties = 1 AND quarantined
    UNION ALL SELECT 'cohortPropertyOwner', link.property_id::text FROM legacy_link link
      JOIN hotel_catalog.properties property ON property.id = link.property_id
      LEFT JOIN cohort_owner owner USING (property_id)
      LEFT JOIN identity.organizations organization ON organization.id = owner.organization_id
     WHERE link.inside GROUP BY link.property_id
    HAVING count(DISTINCT owner.organization_id) <> 1
        OR NOT bool_and(organization.kind = 'hotel_group' AND organization.status = 'active')
    UNION ALL SELECT 'cohortPropertyEntitlement', owner.property_id::text FROM cohort_owner owner
      LEFT JOIN identity.product_entitlements entitlement
        ON entitlement.organization_id = owner.organization_id AND entitlement.product = 'pms'
       AND entitlement.entitlement_key IN ('property-management', 'pms-core', 'account_access')
       AND (entitlement.resource_product IS NULL
         OR (entitlement.resource_product = 'pms' AND entitlement.resource_type = 'pms_property'
           AND entitlement.resource_id = owner.property_id::text))
       AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
       AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
     GROUP BY owner.property_id, owner.organization_id
    HAVING NOT coalesce(bool_or(entitlement.status = 'active'), FALSE)
        OR coalesce(bool_or(entitlement.status = 'suspended'), FALSE)
    UNION ALL SELECT 'profileNotPrivate', property.id::text FROM hotel_catalog.properties property
      JOIN outside ON outside.property_id = property.id WHERE property.profile_status <> 'private'
    UNION ALL SELECT 'profileNotPrivate', profile.property_id::text
      FROM hotel_catalog.property_public_profile_read_model profile
      JOIN outside USING (property_id) WHERE profile.profile_status <> 'private'
    UNION ALL SELECT 'verifiedDomain', profile.property_id::text
      FROM hotel_catalog.property_public_profile_read_model profile
      JOIN outside USING (property_id) WHERE profile.verified_custom_domain IS NOT NULL
    UNION ALL SELECT 'verifiedDomain', domain.property_id::text FROM hotel_catalog.property_domains domain
      JOIN outside USING (property_id) WHERE domain.verification_status = 'verified'
    UNION ALL SELECT 'publicMedia', media.property_id::text FROM hotel_catalog.property_media media
      JOIN outside USING (property_id) WHERE media.public_approved
    UNION ALL SELECT 'publicMedia', media.property_id::text FROM platform.media_objects media
      JOIN outside USING (property_id)
     WHERE media.deleted_at IS NULL AND (media.visibility = 'public' OR media.public_approved)
    UNION ALL SELECT 'publicOffers', promo.property_id::text FROM booking.promo_definitions promo
      JOIN outside USING (property_id) WHERE promo.is_active OR promo.status = 'active'
    UNION ALL SELECT 'publicOffers', offer.property_id::text
      FROM distribution.public_room_offer_snapshots offer
      JOIN outside USING (property_id) WHERE offer.sellable_publicly
    UNION ALL SELECT 'publicOffers', profile.property_id::text
      FROM distribution.public_hotel_bookability_profiles profile
      JOIN outside USING (property_id) WHERE profile.profile_status = 'public'
    UNION ALL SELECT 'publicAddons', addon.property_id::text FROM booking.addon_definitions addon
      JOIN outside USING (property_id) WHERE addon.public_visible
    UNION ALL SELECT 'marketplaceListing', offer.property_id::text
      FROM marketplace.marketplace_offers offer
      JOIN outside USING (property_id) WHERE offer.offer_status = 'verified'
    UNION ALL SELECT 'marketplaceListing', offer.property_id::text
      FROM marketplace.marketplace_offer_read_model offer
      JOIN outside USING (property_id) WHERE offer.visibility_status IN ('public', 'unlisted')
    UNION ALL SELECT 'marketplaceListing', profile.property_id::text
      FROM marketplace.marketplace_hotel_profiles profile
      JOIN outside USING (property_id) WHERE profile.marketplace_profile_status = 'verified'
    UNION ALL SELECT 'activeOwnerLink', property_id::text FROM owner_link WHERE status = 'active'
    UNION ALL SELECT 'activeMembership', owner_link.property_id::text FROM owner_link
      JOIN identity.organizations organization
        ON organization.id = owner_link.organization_id AND organization.status = 'active'
      JOIN identity.organization_memberships membership
        ON membership.organization_id = organization.id AND membership.status = 'active'
    UNION ALL SELECT 'activeEntitlement', resource.property_id::text
      FROM outside_resource resource
      JOIN identity.product_entitlements entitlement
        ON lower(entitlement.resource_id) = resource.resource_id
     WHERE entitlement.status = 'active'
       AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
    UNION ALL SELECT 'connectedChannel', connection.property_id::text
      FROM pms.channel_connections connection
      JOIN outside USING (property_id) WHERE connection.connection_status IN ('connected', 'degraded')
    UNION ALL SELECT 'activeChannexMapping', mapping.property_id::text
      FROM pms.channel_room_type_mappings mapping
      JOIN outside USING (property_id) WHERE mapping.status = 'active'
    UNION ALL SELECT 'activeChannexMapping', mapping.property_id::text
      FROM pms.channel_rate_plan_mappings mapping
      JOIN outside USING (property_id) WHERE mapping.status = 'active'
    UNION ALL SELECT 'bindingClaim', claim.property_id::text FROM pms.channel_binding_claims claim
      JOIN outside USING (property_id) WHERE claim.claim_state <> 'released'
    UNION ALL SELECT 'enabledProviderAccount', account.property_id::text
      FROM finance.payment_provider_accounts account
      JOIN outside USING (property_id) WHERE account.charges_enabled OR account.payouts_enabled
    UNION ALL SELECT 'enabledProviderAccount', settings.property_id::text
      FROM finance.payment_settings settings
      JOIN outside USING (property_id) WHERE settings.payments_enabled
    UNION ALL SELECT 'actionablePayout', outside.property_id::text FROM finance.payouts payout
      JOIN outside
        ON outside.property_id IN (payout.property_id, payout.related_property_id)
     WHERE payout.payout_status IN ('pending', 'scheduled', 'processing', 'failed')
  ) AS violation
  ORDER BY category, "subjectId"`;

/** SELECT-only; null when the source run has no stored cohort. Runs inside the parity read. */
export async function readProductionParityCohortScope(
  client: QueryClient,
  sourceRunId: string,
): Promise<ProductionParityCohortScopeEvidence | null> {
  const cohort = await readProductionMigrationCohort(client, sourceRunId);
  if (!cohort) return null;
  const params = [cohort.bookingHotelIds, cohort.pmsHotelIds, cohort.marketplaceHotelIds];
  const counts = await client.query<{ cohortProperties: string; nonCohortProperties: string }>(
    SCOPE_COUNT_QUERY,
    params,
  );
  const violations = await client.query<{ category: CohortScopeCategory; subjectId: string }>(
    SCOPE_VIOLATION_QUERY,
    params,
  );
  return {
    cohortSha256: cohort.cohortSha256,
    approvalProofSha256: cohort.approvalProofSha256,
    cohortProperties: Number(counts.rows[0]?.cohortProperties ?? 0),
    nonCohortProperties: Number(counts.rows[0]?.nonCohortProperties ?? 0),
    violations: violations.rows,
  };
}

/**
 * Applies only when a cohort is configured or stored for the run; otherwise it returns nothing,
 * so a run without a cohort keeps its report and checksum. Subjects appear only as hashes.
 */
export function evaluateCohortScope(
  config: { cohortSha256?: string; cohortApprovalProofSha256?: string },
  scope: ProductionParityCohortScopeEvidence | null | undefined,
): { findings: ProductionParityFinding[]; summary?: ProductionParityCohortScopeSummary } {
  if (!config.cohortSha256 && !scope) return { findings: [] };
  const cohortTable = "platform.production_migration_cohorts";
  if (!scope)
    return {
      findings: [
        finding(
          "fail",
          cohortTable,
          "The configured migration cohort is not stored for the run",
          config.cohortSha256!,
          "Missing",
        ),
      ],
    };
  const findings: ProductionParityFinding[] = [];
  for (const [configured, stored, what] of [
    [config.cohortSha256 ?? "No cohort configured", scope.cohortSha256, "cohort"],
    [
      config.cohortApprovalProofSha256 ?? scope.approvalProofSha256,
      scope.approvalProofSha256,
      "cohort approval proof",
    ],
  ])
    if (configured !== stored)
      findings.push(
        finding(
          "fail",
          cohortTable,
          `The stored ${what} differs from the configured ${what}`,
          configured,
          stored,
        ),
      );
  const violations = Object.fromEntries(
    COHORT_SCOPE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<CohortScopeCategory, number>;
  for (const category of COHORT_SCOPE_CATEGORIES) {
    const subjects = [
      ...new Set(
        scope.violations
          .filter((row) => row.category === category)
          .map((row) => `sha256:${sha256(row.subjectId)}`),
      ),
    ].sort();
    violations[category] = subjects.length;
    if (subjects.length > 0)
      findings.push(
        finding(
          "fail",
          `cohort_scope.${category}`,
          MESSAGES[category],
          "0",
          `${subjects.length}: ${subjects.join(", ")}`,
        ),
      );
  }
  if (findings.length === 0)
    findings.push(
      finding(
        "pass",
        cohortTable,
        "Cohort hotels resolve to canonical properties; the rest are private, without access and inert",
        "Verified",
        `${scope.cohortProperties} cohort, ${scope.nonCohortProperties} outside the cohort`,
      ),
    );
  return {
    findings,
    summary: {
      cohortProperties: scope.cohortProperties,
      nonCohortProperties: scope.nonCohortProperties,
      violations,
    },
  };
}

function finding(
  severity: "pass" | "fail",
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
): ProductionParityFinding {
  const code = "COHORT_SCOPE_VERIFIED";
  return { severity, code, owner: "Migration cohort", targetObject, message, expected, actual };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
