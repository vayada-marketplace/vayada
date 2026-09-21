import type pg from "pg";
import { requireAffiliateReadinessTransaction } from "./bookingAffiliateReferralReadiness.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Scope = { propertyId: string; organizationId: string; destinationVersionId: string };
type Result =
  | { status: "blocked" }
  | {
      status: "native_candidate";
      propertyId: string;
      destinationVersionId: string;
      bookingUrl: string;
    };

/** Current-state Booking-owned URL candidate only. The redirect gate still needs
 * host/chain evidence and must coordinate concurrent canonical-domain changes. */
export async function readNativeAffiliateDestinationSafety(
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

  const row = (
    await client.query(
      `SELECT destination.booking_url, canonical.slug
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
  ).rows[0] as { booking_url: string; slug: string } | undefined;
  if (!row || !slug.test(row.slug)) return { status: "blocked" };
  const expected = `https://${row.slug}.next-booking.vayada.com/`;
  if (row.booking_url !== expected) return { status: "blocked" };
  return {
    status: "native_candidate",
    propertyId: scope.propertyId.toLowerCase(),
    destinationVersionId: scope.destinationVersionId.toLowerCase(),
    bookingUrl: expected,
  };
}
