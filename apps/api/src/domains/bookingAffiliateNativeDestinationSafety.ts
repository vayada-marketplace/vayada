import type pg from "pg";
import {
  AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION,
  buildAffiliateArrivalRedirect,
  type AffiliateDestinationSafetyEvidence,
} from "@vayada/domain-booking";
import { lockAffiliateDestinationSafety } from "./bookingAffiliateDestinationSafetyLock.js";
import { requireAffiliateReadinessTransaction } from "./bookingAffiliateReferralReadiness.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Scope = { propertyId: string; organizationId: string; destinationVersionId: string };
type Result = { status: "blocked" } | AffiliateDestinationSafetyEvidence;

/** Resolves fresh safety evidence while the per-property safety lock is held. */
async function readNativeAffiliateDestinationSafety(
  client: pg.PoolClient,
  scope: Scope,
): Promise<Result> {
  await requireAffiliateReadinessTransaction(client);
  if (
    !uuid.test(scope.propertyId) ||
    !uuid.test(scope.organizationId) ||
    !uuid.test(scope.destinationVersionId)
  )
    return { status: "blocked" };

  await lockAffiliateDestinationSafety(client, scope.propertyId);

  const row = (
    await client.query(
      `SELECT destination.booking_url, canonical.slug, clock_timestamp() AS validated_at
       FROM booking.affiliate_destination_versions destination
       JOIN hotel_catalog.properties property ON property.id=destination.property_id
         AND property.lifecycle_status='active' AND property.profile_status='complete'
       JOIN hotel_catalog.property_slugs canonical ON canonical.property_id=property.id
         AND canonical.purpose='canonical' AND canonical.status='active'
       WHERE destination.id=$1 AND destination.property_id=$2
         AND destination.created_by_organization_id=$3
         AND NOT EXISTS (
           SELECT 1 FROM hotel_catalog.property_domains domain
           WHERE domain.property_id=property.id AND domain.verification_status='verified'
             AND domain.canonical_when_verified=TRUE
         )
       FOR SHARE OF destination,property,canonical`,
      [scope.destinationVersionId, scope.propertyId, scope.organizationId],
    )
  ).rows[0] as { booking_url: string; slug: string; validated_at: Date } | undefined;
  if (!row || !slug.test(row.slug)) return { status: "blocked" };
  const expected = `https://${row.slug}.next-booking.vayada.com/`;
  if (row.booking_url !== expected) return { status: "blocked" };
  const propertyId = scope.propertyId.toLowerCase();
  const destinationVersionId = scope.destinationVersionId.toLowerCase();
  return {
    status: "approved",
    policyVersion: AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION,
    method: "native_vayada_host",
    propertyId,
    destinationVersionId,
    bookingUrl: expected,
    redirectChain: [expected],
    evidenceReference:
      `booking:native-affiliate-destination-safety:v1:${propertyId}:` +
      `${destinationVersionId}:${row.slug}`,
    validatedAt: row.validated_at.toISOString(),
  };
}

/**
 * Constructs the redirect while the caller's transaction holds the same lock
 * used by every custom-domain mutation. Commit only after this returns.
 */
export async function buildNativeAffiliateArrivalRedirect(
  client: pg.PoolClient,
  scope: Scope,
  opaqueReferenceToken: unknown,
  now?: Date,
) {
  const safety = await readNativeAffiliateDestinationSafety(client, scope);
  return safety.status === "blocked"
    ? safety
    : buildAffiliateArrivalRedirect(
        safety,
        opaqueReferenceToken,
        now ?? new Date(safety.validatedAt),
      );
}
