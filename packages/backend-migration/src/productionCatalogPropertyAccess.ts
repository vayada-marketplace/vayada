import type pg from "pg";

import type { CatalogOwnerLink, CatalogPropertyGroup } from "./productionCatalogOwnership.js";
import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import { addBlocker } from "./productionIdentitySourceValidation.js";

// VAY-1362: native hotel setup links a property as (hotel_catalog, property) and (pms,
// pms_property); runtime tenancy (VAY-1543 pricing, Channex adoption) requires exactly one active
// hotel organization holding both, plus an active PMS entitlement for the property.
type QueryClient = Pick<pg.ClientBase, "query">;
export type CatalogPropertyAccessLink = {
  organizationId: string;
  product: "hotel_catalog" | "pms";
  resourceType: "property" | "pms_property";
  resourceId: string;
  relationship: "owner" | "operator";
  status: "active";
};
const ENTITLEMENT = {
  product: "pms",
  entitlementKey: "property-management",
  status: "active",
  resourceProduct: "pms",
  resourceType: "pms_property",
  metadata: { source: "legacy_migration_cohort" },
} as const;
export type CatalogPropertyAccessEntitlement = typeof ENTITLEMENT & {
  organizationId: string;
  resourceId: string;
};
const LINK_TYPES = [
  ["hotel_catalog", "property"],
  ["pms", "pms_property"],
] as const;
export type CatalogPropertyAccessWrites = {
  links: CatalogPropertyAccessLink[];
  entitlements: CatalogPropertyAccessEntitlement[];
};
type StoredLink = Record<keyof CatalogPropertyAccessLink, string>;
/** Stored PMS grants of the cohort properties. */
type StoredEntitlement = {
  organizationId: string;
  entitlementKey: string;
  resourceId: string | null;
  status: string;
};
export type CatalogPropertyAccessTarget = {
  activeOrganizationIds: string[];
  links: StoredLink[];
  entitlements: StoredEntitlement[];
};

/** Every canonical (cohort) property gets both native links and its entitlement in the one
 * active hotel organization that owns its legacy members; anything else blocks before writes. */
export function planCatalogPropertyAccess(
  properties: CatalogPropertyGroup[],
  ownerLinks: CatalogOwnerLink[],
  target: CatalogPropertyAccessTarget = { activeOrganizationIds: [], links: [], entitlements: [] },
) {
  const active = new Set(target.activeOrganizationIds);
  const owners = new Map(
    ownerLinks
      .filter((link) => link.status === "active" && active.has(link.organizationId))
      .map((link) => [
        `${link.product}:${link.resourceType}:${link.resourceId.toLowerCase()}`,
        link,
      ]),
  );
  const writes: CatalogPropertyAccessWrites = { links: [], entitlements: [] };
  const blockers: IdentityMigrationBlocker[] = [];
  for (const group of properties.filter((row) => row.migrationDisposition === "canonical")) {
    const links = [
      ...(group.booking ? [`booking:booking_hotel:${group.booking.sourceId}`] : []),
      ...group.pms.map((row) => `pms:pms_hotel:${row.sourceId}`),
      ...group.marketplace.map((row) => `marketplace:hotel_profile:${row.sourceId}`),
    ].flatMap((key) => owners.get(key) ?? []);
    const organizations = new Set(links.map((link) => link.organizationId));
    const [organizationId] = organizations;
    if (organizations.size !== 1) {
      addBlocker(
        blockers,
        "COHORT_PROPERTY_OWNER_UNRESOLVED",
        "hotel_catalog.properties",
        group.propertyId,
        `Cohort property resolves to ${organizations.size} active hotel organizations, not one`,
      );
      continue;
    }
    const relationship = links.some((link) => link.relationship === "owner") ? "owner" : "operator";
    const base = { organizationId: organizationId!, resourceId: group.propertyId };
    const status = "active" as const;
    const desired = LINK_TYPES.map(([product, resourceType]) => ({
      ...base,
      product,
      resourceType,
      relationship,
      status,
    }));
    writes.links.push(...desired);
    writes.entitlements.push({ ...base, ...ENTITLEMENT });
  }
  // A stored row of any status is kept as it is, never reactivated.
  const storedLinks = new Set(target.links.map(linkKey));
  const storedEntitlements = new Set(
    target.entitlements
      .filter((row) => row.entitlementKey === ENTITLEMENT.entitlementKey)
      .map(entitlementKey),
  );
  const links = sortedBy(writes.links, linkKey);
  const entitlements = sortedBy(writes.entitlements, entitlementKey);
  return {
    links,
    entitlements,
    pending: {
      links: links.filter((row) => !storedLinks.has(linkKey(row))),
      entitlements: entitlements.filter((row) => !storedEntitlements.has(entitlementKey(row))),
    },
    blockers,
  };
}

const linkKey = (row: StoredLink) =>
  `${row.organizationId}:${row.product}:${row.resourceType}:${row.resourceId}:${row.relationship}`;
const entitlementKey = (row: { organizationId: string; resourceId: string | null }) =>
  `${row.organizationId}:${row.resourceId}`;

export async function readCatalogPropertyAccessTarget(
  client: QueryClient,
  propertyIds: string[],
): Promise<CatalogPropertyAccessTarget> {
  const organizations = await client.query<{ id: string }>(
    `SELECT id::text FROM identity.organizations
      WHERE kind = 'hotel_group' AND status = 'active' ORDER BY id`,
  );
  const links = await client.query<StoredLink>(
    `SELECT organization_id::text AS "organizationId", product, resource_type AS "resourceType",
            resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links
      WHERE (product, resource_type) IN (('hotel_catalog', 'property'), ('pms', 'pms_property'))
        AND resource_id = ANY($1::text[])
      ORDER BY organization_id, product, resource_type, resource_id, relationship`,
    [propertyIds],
  );
  const entitlements = await client.query<StoredEntitlement>(
    `SELECT organization_id::text AS "organizationId", entitlement_key AS "entitlementKey",
            resource_id AS "resourceId", status
       FROM identity.product_entitlements
      WHERE product = 'pms' AND entitlement_key = 'property-management'
        AND resource_product = 'pms' AND resource_type = 'pms_property'
        AND resource_id = ANY($1::text[])
      ORDER BY organization_id, entitlement_key, resource_id`,
    [propertyIds],
  );
  return {
    activeOrganizationIds: organizations.rows.map((row) => row.id),
    links: links.rows,
    entitlements: entitlements.rows,
  };
}

/** Inserts missing rows only (ON CONFLICT DO NOTHING), like native track provisioning. */
export async function writeCatalogPropertyAccess(
  client: QueryClient,
  writes: CatalogPropertyAccessWrites,
): Promise<{ propertyLinks: number; propertyEntitlements: number }> {
  const insert = async (rows: unknown[], sql: string) =>
    rows.length ? ((await client.query(sql, [JSON.stringify(rows)])).rowCount ?? 0) : 0;
  return {
    propertyLinks: await insert(
      writes.links,
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       SELECT "organizationId", product, "resourceType", "resourceId", relationship, status
       FROM jsonb_to_recordset($1::jsonb) AS source("organizationId" uuid, product text,
         "resourceType" text, "resourceId" text, relationship text, status text)
       ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
       DO NOTHING`,
    ),
    propertyEntitlements: await insert(
      writes.entitlements,
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type,
          resource_id, metadata)
       SELECT "organizationId", product, "entitlementKey", status, "resourceProduct",
              "resourceType", "resourceId", metadata
       FROM jsonb_to_recordset($1::jsonb) AS source("organizationId" uuid, product text,
         "entitlementKey" text, status text, "resourceProduct" text, "resourceType" text,
         "resourceId" text, metadata jsonb)
       ON CONFLICT (organization_id, product, entitlement_key, COALESCE(resource_product, ''),
                    COALESCE(resource_type, ''), COALESCE(resource_id, ''))
       DO NOTHING`,
    ),
  };
}
