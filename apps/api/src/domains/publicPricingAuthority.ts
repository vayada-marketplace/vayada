import type { PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockCurrentPmsPricingEntitlement } from "./replacementPricingAuthorization.js";

/** Internal public-access boundary. Caller owns a READ COMMITTED transaction and retains
 * its locks through source reads/acceptance. This does not validate rates, stay eligibility,
 * calendar/inventory, payment readiness or other pricing owners. Never accept a client scope.
 * The owning organization is the single one linked as owner/operator to both the PMS
 * property and the catalog property (VAY-2079); none or several fail closed. */
export async function lockPublicPricingAuthority(client: PoolClient, slug: unknown) {
  if (typeof slug !== "string" || !slug.length || slug.length > 200 || slug !== slug.trim())
    return null;
  // Distribution reserves locale-less canonical slugs. Their existing unique index
  // provides one URL identity; localized catalog slugs are not public booking targets.
  const candidates = (
    await client.query(
      `SELECT property_id FROM hotel_catalog.property_slugs
    WHERE slug=$1 AND locale IS NULL AND purpose='canonical' AND status='active'`,
      [slug],
    )
  ).rows;
  if (candidates.length !== 1) return null;
  const propertyId = candidates[0].property_id as string;
  // Inventory lock precedes identity/catalog locks, matching pricing publication writers.
  await lockPmsInventoryMutationScope(client, propertyId);
  const organizationId = await owningOrganization(client, propertyId);
  if (!organizationId) return null;
  const organization = await client.query(
    `SELECT id FROM identity.organizations
    WHERE id=$1 AND kind='hotel_group' AND status='active' FOR UPDATE`,
    [organizationId],
  );
  if (!organization.rowCount) return null;
  // Re-resolve after the property lock: the discovery lookup grants no access.
  const profiles = (
    await client.query(
      `SELECT profile.expires_at
    FROM hotel_catalog.property_slugs s
    JOIN hotel_catalog.properties p ON p.id=s.property_id
    JOIN hotel_catalog.property_locations location ON location.property_id=p.id
    JOIN distribution.public_hotel_bookability_profiles profile ON profile.property_id=p.id
    WHERE s.slug=$1 AND s.locale IS NULL AND s.property_id=$2 AND s.purpose='canonical' AND s.status='active'
      AND p.lifecycle_status='active' AND p.profile_status='complete'
      AND profile.public_visibility='public_safe' AND profile.profile_status='public'
      AND profile.canonical_slug=s.slug AND profile.public_id=p.public_id
      AND profile.freshness_status='fresh'
      AND profile.public_setup_completeness->>'status'='ready'
      AND CASE WHEN jsonb_typeof(profile.capabilities->'paymentMethods')='array'
        THEN jsonb_array_length(profile.capabilities->'paymentMethods')>0 ELSE false END
    FOR SHARE OF s,p,location,profile`,
      [slug, propertyId],
    )
  ).rows;
  if (profiles.length !== 1) return null;
  const links = (
    await client.query(
      `SELECT product FROM identity.organization_resource_links
    WHERE organization_id=$1 AND resource_id=$2 AND status='active'
      AND relationship IN ('owner','operator')
      AND ((product='pms' AND resource_type='pms_property')
        OR (product='hotel_catalog' AND resource_type='property')) FOR SHARE`,
      [organizationId, propertyId],
    )
  ).rows;
  if (!links.some((r) => r.product === "pms") || !links.some((r) => r.product === "hotel_catalog"))
    return null;
  // Separate statement after the link locks: a link added to another organization meanwhile
  // makes ownership ambiguous.
  if ((await owningOrganization(client, propertyId)) !== organizationId) return null;
  if (!(await lockCurrentPmsPricingEntitlement(client, organizationId, propertyId))) return null;
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  if (profiles[0].expires_at && profiles[0].expires_at <= now) return null;
  return { propertyId, organizationId };
}

/** The one organization with active owner/operator links to both the PMS and catalog
 * property, or null when there is none or more than one. Discovery only: callers lock. */
async function owningOrganization(client: PoolClient, propertyId: string) {
  const owners = (
    await client.query(
      `SELECT organization_id FROM identity.organization_resource_links
    WHERE resource_id=$1 AND status='active' AND relationship IN ('owner','operator')
      AND ((product='pms' AND resource_type='pms_property')
        OR (product='hotel_catalog' AND resource_type='property'))
    GROUP BY organization_id HAVING count(DISTINCT product)=2`,
      [propertyId],
    )
  ).rows;
  return owners.length === 1 ? (owners[0].organization_id as string) : null;
}
