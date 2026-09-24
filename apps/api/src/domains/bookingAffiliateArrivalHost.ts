import { parseBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import type pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

import { admitAffiliateArrivalInTransaction } from "./bookingAffiliateClickAdmission.js";
import { lockAffiliateDestinationSafety } from "./bookingAffiliateDestinationSafetyLock.js";
import { lockBookingPublication } from "./bookingPublicationLock.js";

type QueryPort = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type HostRow = QueryResultRow & { propertyId: string; publicContent: unknown };

function normalizedArrivalHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return null;
  }
  const normalized = decoded.replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
  return normalized === decoded &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) &&
    !normalized.includes("..")
    ? normalized
    : null;
}

function bookingSlug(host: string): string | null {
  const parts = host.split(".");
  if (
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".next-booking.vayada.com") ||
    host.endsWith(".booking.localhost")
  ) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  return null;
}

/** Reads only the active public Booking identity needed to bind a final host to a property. */
export async function readBookingAffiliateArrivalHost(
  database: QueryPort,
  suppliedHost: unknown,
): Promise<{ host: string; propertyId: string } | undefined> {
  const host = normalizedArrivalHost(suppliedHost);
  if (!host) return undefined;
  const slug = bookingSlug(host);
  const result = await database.query<HostRow>(
    `SELECT active.property_id::text AS "propertyId",revision.public_content AS "publicContent"
     FROM distribution.active_public_booking_revision active
     JOIN distribution.public_booking_content_revisions revision
       ON revision.id=active.content_revision_id AND revision.property_id=active.property_id
     WHERE revision.public_content ->> 'contractVersion'='booking-public-content.v1'
       AND CASE WHEN $2::text IS NOT NULL THEN EXISTS (
         SELECT 1 FROM hotel_catalog.property_slugs canonical
         WHERE canonical.property_id=active.property_id AND canonical.slug=$2
           AND canonical.purpose='canonical' AND canonical.status='active'
       ) AND NOT EXISTS (
         SELECT 1 FROM hotel_catalog.property_domains current_domain
         WHERE current_domain.property_id=active.property_id
           AND current_domain.verification_status='verified'
           AND current_domain.canonical_when_verified=TRUE
       ) ELSE EXISTS (
         SELECT 1 FROM hotel_catalog.property_domains domain
         WHERE domain.property_id=active.property_id AND domain.hostname=$1
           AND domain.verification_status='verified' AND domain.canonical_when_verified=TRUE
       ) END
     LIMIT 2`,
    [host, slug],
  );
  if (result.rows.length !== 1) return undefined;
  const row = result.rows[0]!;
  const profile = parseBookingPublicContent(row.publicContent)?.profile;
  if (
    !profile ||
    profile.hotel.propertyId !== row.propertyId ||
    profile.hotel.trust.bookabilityStatus !== "bookable" ||
    profile.freshness.status !== "fresh"
  )
    return undefined;
  let canonical: URL;
  try {
    canonical = new URL(profile.hotel.bookingBaseUrl);
  } catch {
    return undefined;
  }
  if (
    canonical.protocol !== "https:" ||
    canonical.port ||
    canonical.hostname.toLowerCase() !== host
  )
    return undefined;
  if (slug) {
    if (profile.hotel.slug !== slug) return undefined;
  } else {
    try {
      if (
        !profile.hotel.customDomainUrl ||
        new URL(profile.hotel.customDomainUrl).hostname.toLowerCase() !== host
      )
        return undefined;
    } catch {
      return undefined;
    }
  }
  return { host, propertyId: row.propertyId };
}

/** Holds coordinated Catalog-domain, Booking-publication, and property identity stable. */
export async function lockBookingAffiliateArrivalHostScope(
  client: pg.PoolClient,
  propertyId: string,
): Promise<boolean> {
  await lockAffiliateDestinationSafety(client, propertyId);
  await lockBookingPublication(client, propertyId);
  const property = await client.query(
    `SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR SHARE`,
    [propertyId],
  );
  return property.rowCount === 1;
}

/**
 * Rechecks the final host under the Catalog-domain and Booking-publication locks,
 * then admits the opaque click in the same transaction.
 */
export async function admitAffiliateArrivalForCurrentHost(
  pool: pg.Pool,
  input: { host: unknown; referenceToken: unknown; contextId?: unknown },
) {
  const candidate = await readBookingAffiliateArrivalHost(pool, input.host);
  if (!candidate) return { status: "unavailable" as const };
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const propertyLocked = await lockBookingAffiliateArrivalHostScope(client, candidate.propertyId);
    const current = await readBookingAffiliateArrivalHost(client, candidate.host);
    if (!propertyLocked || current?.propertyId !== candidate.propertyId) {
      await client.query("ROLLBACK");
      return { status: "unavailable" as const };
    }
    const admitted = await admitAffiliateArrivalInTransaction(client, {
      propertyId: candidate.propertyId,
      referenceToken: input.referenceToken,
      contextId: input.contextId,
    });
    if (admitted.status !== "admitted") {
      await client.query("ROLLBACK");
      return admitted;
    }
    await client.query("COMMIT");
    return admitted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
