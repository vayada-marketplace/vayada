import type { PoolClient } from "pg";
import {
  lockChannexPricingJobLease,
  type ChannexPricingJobLeaseInput,
  type ChannexPricingJobLease,
} from "../jobs/pmsChannexPricingJobLease.js";

export type ChannexPricingPropertyAuthority =
  | {
      kind: "unavailable";
      reason: "lease_unavailable" | "scope_unavailable" | "connection_unavailable";
    }
  | {
      kind: "authorized";
      lease: ChannexPricingJobLease;
      organizationId: string;
      connectionId: string;
      claimId: string;
      externalPropertyId: string;
    };

/** Caller owns a bounded SERIALIZABLE transaction and retries 55P03/40001 after rollback.
 * Authority is a coherent transaction snapshot, not a send permit. The full reader
 * must take its publication/owner locks and recheck this boundary before returning;
 * delivery must start a fresh authority/freshness check before provider dispatch.
 */
export async function lockChannexPricingPropertyAuthority(
  client: PoolClient,
  input: ChannexPricingJobLeaseInput,
): Promise<ChannexPricingPropertyAuthority> {
  const leaseInput = { ...input };
  const isolation = await client.query("SHOW transaction_isolation");
  if (isolation.rows[0]?.transaction_isolation !== "serializable")
    throw new Error("Serializable pricing authority transaction required");
  const lease = await lockChannexPricingJobLease(client, leaseInput);
  if (!lease) return { kind: "unavailable", reason: "lease_unavailable" };
  const unavailable = { kind: "unavailable", reason: "scope_unavailable" } as const;
  const property = await client.query(
    "SELECT id FROM hotel_catalog.properties WHERE id=$1 AND profile_status<>'disabled' FOR SHARE NOWAIT",
    [lease.propertyId],
  );
  if (!property.rowCount) return unavailable;
  const owners = await client.query<{ id: string }>(
    `SELECT o.id::text
    FROM identity.organizations o
    JOIN identity.organization_resource_links c ON c.organization_id=o.id
      AND c.product='hotel_catalog' AND c.resource_type='property' AND c.resource_id=$1
      AND c.status='active' AND c.relationship IN ('owner','operator')
    JOIN identity.organization_resource_links p ON p.organization_id=o.id
      AND p.product='pms' AND p.resource_type='pms_property' AND p.resource_id=$1
      AND p.status='active' AND p.relationship IN ('owner','operator')
    WHERE o.kind='hotel_group' AND o.status='active'
    FOR UPDATE OF o NOWAIT FOR SHARE OF c,p NOWAIT`,
    [lease.propertyId],
  );
  const organizations = [...new Set(owners.rows.map((row) => row.id))];
  if (organizations.length !== 1) return unavailable;
  const organizationId = organizations[0];
  // Lock all organization rows, including currently unrelated scopes that could be retargeted.
  const entitlements = (
    await client.query(
      `SELECT product,entitlement_key,status,resource_product,resource_type,resource_id,starts_at,expires_at
    FROM identity.product_entitlements WHERE organization_id=$1 FOR SHARE NOWAIT`,
      [organizationId],
    )
  ).rows;
  const connection = (
    await client.query<{ connectionId: string; claimId: string; externalPropertyId: string }>(
      `SELECT c.id::text AS "connectionId", b.id::text AS "claimId", c.external_property_id AS "externalPropertyId"
    FROM pms.channel_connections c JOIN pms.channel_binding_claims b
      ON b.property_id=c.property_id AND b.provider=c.provider AND b.external_property_id=c.external_property_id
    WHERE c.property_id=$1 AND c.provider='channex' AND b.claim_state='active'
      AND c.connection_status IN ('connected','degraded','setup_incomplete')
    FOR SHARE OF c,b NOWAIT`,
      [lease.propertyId],
    )
  ).rows[0];
  if (!connection) return { kind: "unavailable", reason: "connection_unavailable" };
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  const applicable = entitlements.filter(
    (e) =>
      e.product === "pms" &&
      ["property-management", "pms-core", "account_access"].includes(e.entitlement_key) &&
      (!e.resource_product ||
        (e.resource_product === "pms" &&
          e.resource_type === "pms_property" &&
          e.resource_id === lease.propertyId)) &&
      (!e.starts_at || e.starts_at <= now) &&
      (!e.expires_at || e.expires_at > now),
  );
  if (
    !applicable.some((e) => e.status === "active") ||
    applicable.some((e) => e.status === "suspended")
  )
    return unavailable;
  if (!(await lockChannexPricingJobLease(client, leaseInput)))
    return { kind: "unavailable", reason: "lease_unavailable" };
  return { kind: "authorized", lease, organizationId, ...connection };
}
