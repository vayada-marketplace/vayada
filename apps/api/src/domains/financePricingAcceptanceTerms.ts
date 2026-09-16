import type { PoolClient } from "pg";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { toBillingConfig } from "./financeBillingConfigReadModel.js";

const instant = (value: unknown) =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.valueOf() : NaN;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const percent = (value: unknown) =>
  (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= 100;

/** Finance capture only. Caller owns READ COMMITTED and retains all locks; slug
 * resolves public scope server-side. After later waits, final acceptance must also
 * check validUntil. No nested transaction, booking write or provider operation. */
export async function lockFinancePricingAcceptanceTerms(client: PoolClient, slug: unknown) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return null;
  // Protect absence/insertion through property foreign keys as well as existing rows.
  if (
    !(
      await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
        scope.propertyId,
      ])
    ).rowCount
  )
    return null;
  const entitlements = (
    await client.query(
      `SELECT plan_key,billing_status,provider_subscription_status,
    entitlement_metadata,starts_at,expires_at,updated_at
    FROM finance.billing_entitlements WHERE property_id=$1 AND organization_id=$2
      AND product='booking' AND entitlement_key='direct-booking-finance' FOR SHARE`,
      [scope.propertyId, scope.organizationId],
    )
  ).rows;
  const commissions = (
    await client.query(
      `SELECT percentage_rate,rule_metadata,starts_at,ends_at,updated_at,status,commission_type
    FROM finance.commission_rules WHERE property_id=$1 AND (organization_id IS NULL OR organization_id=$2)
      AND rule_scope='property' AND product='booking' AND source_system='finance'
      AND source_rule_id='onboarding-booking:'||$1::text FOR SHARE`,
      [scope.propertyId, scope.organizationId],
    )
  ).rows;
  if (entitlements.length !== 1 || commissions.length !== 1) return null;
  const entitlement = entitlements[0],
    commission = commissions[0];
  if (
    !object(entitlement.entitlement_metadata) ||
    !object(commission.rule_metadata) ||
    !["trialing", "active"].includes(entitlement.billing_status) ||
    !["commission", "fixed"].includes(entitlement.plan_key) ||
    commission.status !== "active" ||
    commission.commission_type !== "percentage" ||
    !percent(commission.percentage_rate) ||
    Number(commission.percentage_rate) !== 5
  )
    return null;
  if (entitlement.plan_key === "fixed") {
    if (!["trialing", "active"].includes(entitlement.provider_subscription_status)) return null;
  } else {
    const selected = entitlement.entitlement_metadata.planSelectedAt;
    if (typeof selected !== "string" || !Number.isFinite(Date.parse(selected))) return null;
  }
  for (const key of ["channelManagerFeePercent", "affiliatePlatformFeePercent"])
    if (Object.hasOwn(commission.rule_metadata, key) && !percent(commission.rule_metadata[key]))
      return null;
  const latestScope = await lockPublicPricingAuthority(client, slug);
  if (
    !latestScope ||
    latestScope.propertyId !== scope.propertyId ||
    latestScope.organizationId !== scope.organizationId ||
    latestScope.authorityRevision !== scope.authorityRevision
  )
    return null;
  const captured = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const now = instant(captured),
    starts = Math.max(
      entitlement.starts_at === null ? -Infinity : instant(entitlement.starts_at),
      instant(commission.starts_at),
    ),
    ends = Math.min(
      entitlement.expires_at === null ? Infinity : instant(entitlement.expires_at),
      commission.ends_at === null ? Infinity : instant(commission.ends_at),
    ),
    updated = Math.max(instant(entitlement.updated_at), instant(commission.updated_at));
  if (
    !Number.isFinite(now) ||
    !(starts <= now && now < ends) ||
    !Number.isFinite(updated) ||
    updated > now
  )
    return null;
  // Reuse the existing Finance resolver. Only absent optional fee keys inherit
  // its channel=nominal rate / affiliate=0 rules; malformed present keys fail above.
  const config = toBillingConfig(scope.propertyId, {
    activePlan: entitlement.plan_key,
    percentageRate: commission.percentage_rate,
    ruleMetadata: commission.rule_metadata,
    updatedAt: new Date(updated),
  });
  return {
    scope,
    billingPlanSnapshot: config.activePlan,
    commissionTermsSnapshot: {
      bookingEngineFeePercent: config.bookingEngineFeePercent,
      channelManagerFeePercent: config.channelManagerFeePercent,
      affiliatePlatformFeePercent: config.affiliatePlatformFeePercent,
      financeConfigUpdatedAt: config.updatedAt,
    },
    financeTermsCapturedAt: new Date(now).toISOString(),
    validUntil: ends === Infinity ? null : new Date(ends).toISOString(),
  };
}
