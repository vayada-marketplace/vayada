import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import {
  compareLegacyOwnershipBeforeState,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import { readLegacyOwnershipDrift } from "./legacyOwnershipEvidenceReader.js";

/**
 * Exact target relationships + drift, not proof of current identity or access.
 * Requires an authenticated expected manifest and caller-owned transaction/locks.
 * Includes inactive competing owners: historical conflicts require explicit review.
 * Source provenance, status eligibility, WorkOS identity and approvals remain
 * separate gates. This function neither starts transactions nor performs writes.
 */
export async function readLegacyOwnershipTargetEvidence(
  client: AdoptionQueryClient,
  expected: readonly LegacyOwnershipFingerprint[],
  legacyHotelId: string,
): Promise<{ outcome: "target_matches" } | { outcome: "blocked"; reason: string }> {
  if (
    compareLegacyOwnershipBeforeState(expected, expected).outcome !== "unchanged" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(legacyHotelId)
  )
    return { outcome: "blocked", reason: "invalid_expected" };
  const id = (kind: LegacyOwnershipFingerprint["kind"]) =>
    expected.find((row) => row.kind === kind)!.id;
  const source = await client.query<{
    id: string;
    propertyId: string;
    sourceId: string;
    sourceSystem: string;
    sourceTable: string;
    relationship: string;
  }>(
    `SELECT id::text, property_id::text AS "propertyId", source_id AS "sourceId",
      source_system AS "sourceSystem", source_table AS "sourceTable", relationship
    FROM hotel_catalog.property_source_links
    WHERE id = $1::uuid OR (source_system = 'pms' AND source_table = 'hotels'
      AND (source_id = $2 OR property_id = $3::uuid)) ORDER BY id`,
    [id("sourceLink"), legacyHotelId, id("property")],
  );
  const sourceRow = source.rows[0];
  if (
    source.rows.length !== 1 ||
    !sourceRow ||
    sourceRow.id !== id("sourceLink") ||
    sourceRow.propertyId !== id("property") ||
    sourceRow.sourceId !== legacyHotelId ||
    sourceRow.sourceSystem !== "pms" ||
    sourceRow.sourceTable !== "hotels" ||
    sourceRow.relationship !== "operational_input"
  )
    return { outcome: "blocked", reason: "source_link_conflict" };

  const memberships = await client.query<{
    id: string;
    userId: string;
    organizationId: string;
    roleKey: string;
    accessOrigin: string;
    organizationKind: string;
  }>(
    `SELECT m.id::text, m.user_id::text AS "userId", m.organization_id::text AS "organizationId",
      m.role_key AS "roleKey", m.access_origin AS "accessOrigin", o.kind AS "organizationKind"
    FROM identity.organization_memberships m
    LEFT JOIN identity.organizations o ON o.id = m.organization_id
    WHERE m.id = $1::uuid OR (m.organization_id = $2::uuid AND m.role_key = 'hotel_owner')
    ORDER BY m.id`,
    [id("membership"), id("organization")],
  );
  const membership = memberships.rows[0];
  if (
    memberships.rows.length !== 1 ||
    !membership ||
    membership.id !== id("membership") ||
    membership.userId !== id("user") ||
    membership.organizationId !== id("organization") ||
    membership.roleKey !== "hotel_owner" ||
    membership.accessOrigin !== "agency" ||
    membership.organizationKind !== "hotel_group"
  )
    return { outcome: "blocked", reason: "membership_conflict" };

  const links = await client.query<{
    id: string;
    organizationId: string;
    product: string;
    resourceType: string;
    resourceId: string;
    relationship: string;
  }>(
    `SELECT id::text, organization_id::text AS "organizationId", product,
      resource_type AS "resourceType", resource_id AS "resourceId", relationship
    FROM identity.organization_resource_links
    WHERE id = ANY($1::uuid[]) OR (relationship IN ('owner', 'operator') AND (
      (product = 'pms' AND resource_type = 'pms_hotel' AND resource_id = $2) OR
      (product = 'pms' AND resource_type = 'pms_property' AND resource_id = $3) OR
      (product = 'hotel_catalog' AND resource_type = 'property' AND resource_id = $3)))
    ORDER BY id`,
    [[id("legacyLink"), id("canonicalLink"), id("pmsLink")], legacyHotelId, id("property")],
  );
  const required = [
    { id: id("legacyLink"), product: "pms", resourceType: "pms_hotel", resourceId: legacyHotelId },
    {
      id: id("canonicalLink"),
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: id("property"),
    },
    { id: id("pmsLink"), product: "pms", resourceType: "pms_property", resourceId: id("property") },
  ];
  if (
    links.rows.length !== 3 ||
    required.some((requirement) => {
      const matches = links.rows.filter((row) => row.id === requirement.id);
      const row = matches[0];
      return (
        matches.length !== 1 ||
        !row ||
        row.organizationId !== id("organization") ||
        row.product !== requirement.product ||
        row.resourceType !== requirement.resourceType ||
        row.resourceId !== requirement.resourceId ||
        (requirement.id === id("legacyLink")
          ? row.relationship !== "operator"
          : !["owner", "operator"].includes(row.relationship))
      );
    })
  )
    return { outcome: "blocked", reason: "ownership_link_conflict" };

  const drift = await readLegacyOwnershipDrift(client, expected);
  return drift.outcome === "unchanged" ? { outcome: "target_matches" } : drift;
}
