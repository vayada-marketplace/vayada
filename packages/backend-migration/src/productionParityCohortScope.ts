import { createHash } from "node:crypto";

import type pg from "pg";

import { readProductionMigrationCohort } from "./productionMigrationCohort.js";
import type { ProductionParityFinding } from "./productionParity.js";
import {
  summarizeCohortReadiness,
  type CohortReadinessSummary,
} from "./productionPmsCohortActivation.js";
import {
  readCohortReadiness,
  readyForActivation,
  type CohortReadiness,
} from "./productionPmsCohortReadiness.js";

// VAY-1362 COHORT_SCOPE_VERIFIED (engineering/legacy-migration-cohort-scope.md, "Verification").
// Each violation category with the message its finding carries.
const MESSAGES = {
  cohortHotelUnresolved: "A cohort hotel does not resolve to exactly one target property",
  cohortPropertyQuarantined: "A cohort hotel resolves to a private-quarantine property",
  cohortPropertyOwner:
    "A cohort property lacks exactly one active hotel organization with both native owner links",
  cohortPropertyEntitlement:
    "A cohort property's organization lacks an active, unsuspended PMS property entitlement",
  cohortAutoOpen:
    "A cohort property's auto-open row differs from its legacy choice (on: matching; off: none)",
  cohortActiveNotReady:
    "An active cohort property lacks a complete profile or a setup-completeness item (VAY-2066 a-g)",
  cohortReadyNotActive:
    "A provisioning cohort property meets every readiness item, so the import did not activate it",
  cohortRoomFacts:
    "A cohort property has an active room type without native room facts, so runtime room reads fail",
  cohortChannelStamp:
    "A cohort property's Channex connection lacks this run's migrationCohortRunId, or one outside the cohort carries it",
  cohortChannelLive:
    "A cohort property's Channex connection is reachable (status, Channex ID, messaging, an active mapping or claim) before its handover completed with an active claim",
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
  autoOpenNotDisabled:
    "A property outside the cohort lacks an explicitly disabled calendar auto-open setting",
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
  /** Carried cohort PMS properties by lifecycle and the readiness items they miss. */
  readiness?: CohortReadinessSummary;
  violations: Array<{ category: CohortScopeCategory; subjectId: string }>;
};

export type ProductionParityCohortScopeSummary = {
  cohortProperties: number;
  nonCohortProperties: number;
  readiness?: CohortReadinessSummary;
  violations: Record<CohortScopeCategory, number>;
};

type QueryClient = Pick<pg.ClientBase, "query">;

// Outside the cohort is decided from the three ID sets (like outsideCohortSource), never from
// the catalog quarantine reason. $1/$2/$3: Booking, PMS and Marketplace cohort hotel IDs; the
// violation query's $4 is the source run: its PMS snapshot holds the legacy auto-open settings,
// and it is the cohort stamp of the imported Channex connections.
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

// The carried cohort PMS properties the import activates (productionPmsCohortActivation).
const CARRIED_QUERY = `${SCOPE_CTES}
  SELECT DISTINCT link.property_id::text AS "propertyId" FROM legacy_link link
   WHERE link.inside AND link.source_system = 'pms'
     AND link.disposition IS DISTINCT FROM 'private_quarantine'
   ORDER BY 1`;

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
    -- productionPmsCalendarAutoOpenRecords. Without a row auto-open is on by default (VAY-2066
    -- R2): a cohort hotel with legacy auto-open off must have none, one with it on a match.
    UNION ALL SELECT 'cohortAutoOpen', link.property_id::text FROM legacy_link link
      JOIN migration_source_pms.snapshot_rows hotel
        ON hotel.run_id = $4 AND hotel.source_schema = 'public' AND hotel.source_table = 'hotels'
       AND lower(hotel.row_data ->> 'id') = link.source_id
      LEFT JOIN pms.calendar_auto_open_settings setting ON setting.property_id = link.property_id
     WHERE link.inside AND link.source_system = 'pms'
       AND link.disposition IS DISTINCT FROM 'private_quarantine'
       AND NOT CASE
         WHEN NOT coalesce((hotel.row_data ->> 'calendar_auto_open_enabled')::boolean, FALSE)
           THEN setting.property_id IS NULL
         WHEN hotel.row_data ->> 'calendar_auto_open_mode' = 'fixed'
           THEN coalesce(setting.enabled AND setting.mode = 'fixed' AND setting.fixed_end_month
             = date_trunc('month', (hotel.row_data ->> 'calendar_auto_open_fixed_month')::date)::date,
             FALSE)
         ELSE coalesce(setting.enabled AND setting.mode = 'rolling' AND setting.rolling_months
             = coalesce((hotel.row_data ->> 'calendar_auto_open_months')::int, 18), FALSE)
       END
    UNION ALL SELECT 'autoOpenNotDisabled', link.property_id::text FROM legacy_link link
      LEFT JOIN pms.calendar_auto_open_settings setting ON setting.property_id = link.property_id
     WHERE NOT link.inside AND link.source_system = 'pms' AND setting.enabled IS NOT FALSE
    -- productionPmsCohortRoomFacts: the runtime's room-facts read needs these keys.
    UNION ALL SELECT 'cohortRoomFacts', link.property_id::text FROM legacy_link link
      JOIN pms.room_types room_type ON room_type.property_id = link.property_id AND room_type.active
     WHERE link.inside AND link.source_system = 'pms'
       AND link.disposition IS DISTINCT FROM 'private_quarantine'
       AND NOT (room_type.occupancy_limits ? 'total' AND room_type.room_attributes ? 'beds'
                AND room_type.room_attributes ? 'bathroomType')
    -- P12: each cohort hotel's imported Channex connection carries the run as its cohort stamp,
    -- which the handover checks against the stored cohort; none outside the cohort carries it.
    UNION ALL SELECT 'cohortChannelStamp', link.property_id::text FROM legacy_link link
      JOIN pms.channel_connections connection
        ON connection.property_id = link.property_id AND connection.provider = 'channex'
     WHERE link.source_system = 'pms'
       AND CASE WHEN link.inside
         THEN connection.connection_metadata ->> 'migrationCohortRunId' IS DISTINCT FROM $4
         ELSE connection.connection_metadata ->> 'migrationCohortRunId' = $4 END
    -- P12: the import leaves cohort Channex state inert (channexHandover 'pending'). Only the
    -- per-hotel handover makes it live: it writes the active claim and marks itself completed.
    UNION ALL SELECT 'cohortChannelLive', connection.property_id::text
      FROM pms.channel_connections connection
      JOIN (SELECT DISTINCT property_id FROM legacy_link WHERE inside) cohort USING (property_id)
     WHERE connection.provider = 'channex'
       AND (connection.connection_status IN ('connected', 'degraded')
         OR connection.external_property_id IS NOT NULL OR connection.messaging_app_installed
         OR EXISTS (SELECT 1 FROM pms.channel_room_type_mappings mapping
                     WHERE mapping.connection_id = connection.id AND mapping.status = 'active')
         OR EXISTS (SELECT 1 FROM pms.channel_rate_plan_mappings mapping
                     WHERE mapping.connection_id = connection.id AND mapping.status = 'active')
         OR EXISTS (SELECT 1 FROM pms.channel_booking_mappings mapping
                     WHERE mapping.connection_id = connection.id AND mapping.sync_status = 'active')
         -- Webhook intake resolves a property through an active claim alone.
         OR EXISTS (SELECT 1 FROM pms.channel_binding_claims claim
                     WHERE claim.provider = 'channex' AND claim.claim_state = 'active'
                       AND (claim.property_id = connection.property_id OR claim.external_property_id
                         = connection.connection_metadata ->> 'legacyExternalPropertyId')))
       AND (connection.connection_metadata ->> 'channexHandover' IS DISTINCT FROM 'completed'
         OR NOT EXISTS (SELECT 1 FROM pms.channel_binding_claims claim
           WHERE claim.property_id = connection.property_id AND claim.provider = 'channex'
             AND claim.external_property_id = connection.external_property_id
             AND claim.claim_state = 'active'))
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
    UNION ALL SELECT 'autoOpenNotDisabled', setting.property_id::text
      FROM pms.calendar_auto_open_settings setting
      JOIN outside USING (property_id) WHERE setting.enabled
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
    [...params, sourceRunId],
  );
  // VAY-1362 activation: a carried cohort property is active exactly when it is complete and meets
  // a-g (suspended or retired ones aside).
  const carried = await client.query<{ propertyId: string }>(CARRIED_QUERY, params);
  const readiness = await readCohortReadiness(
    client,
    carried.rows.map((row) => row.propertyId),
  );
  const notReady = cohortActivationViolations(readiness);
  return {
    cohortSha256: cohort.cohortSha256,
    approvalProofSha256: cohort.approvalProofSha256,
    cohortProperties: Number(counts.rows[0]?.cohortProperties ?? 0),
    nonCohortProperties: Number(counts.rows[0]?.nonCohortProperties ?? 0),
    readiness: summarizeCohortReadiness(readiness),
    violations: [...violations.rows, ...notReady],
  };
}

/** Carried cohort properties whose lifecycle disagrees with their readiness. */
export function cohortActivationViolations(
  readiness: CohortReadiness[],
): ProductionParityCohortScopeEvidence["violations"] {
  return readiness.flatMap((row): ProductionParityCohortScopeEvidence["violations"] =>
    row.lifecycleStatus === "active" && !readyForActivation(row)
      ? [{ category: "cohortActiveNotReady" as const, subjectId: row.propertyId }]
      : row.lifecycleStatus === "provisioning" && readyForActivation(row)
        ? [{ category: "cohortReadyNotActive" as const, subjectId: row.propertyId }]
        : [],
  );
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
  // Reported with or without violations: the go-day decision needs the counts either way.
  if (scope.readiness)
    findings.push(
      finding(
        "pass",
        "hotel_catalog.properties",
        "Carried cohort properties by lifecycle, and the readiness items provisioning ones miss",
        "Active when complete and ready (VAY-2066 a-g)",
        `${scope.readiness.active} active, ${scope.readiness.provisioning} provisioning; missing ` +
          Object.entries(scope.readiness.missing)
            .map(([criterion, count]) => `${criterion}=${count}`)
            .join(" "),
      ),
    );
  return {
    findings,
    summary: {
      cohortProperties: scope.cohortProperties,
      nonCohortProperties: scope.nonCohortProperties,
      ...(scope.readiness ? { readiness: scope.readiness } : {}),
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
