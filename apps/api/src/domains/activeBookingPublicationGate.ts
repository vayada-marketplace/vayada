import {
  parseBookingPublicContent,
  type BookingPublicContent,
} from "@vayada/domain-distribution/booking-publication";
import type { QueryResultRow } from "pg";

import { manualPublishedPagePayable } from "./financeManualPaymentReadiness.js";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type ActiveBookingPublicationRow = QueryResultRow & {
  propertyId: string;
  publicContent: unknown;
};

export const ACTIVE_BOOKING_PUBLICATION_CONTRACT = "booking-public-content.v1";

/**
 * One rule for whether an active Booking publication is publicly visible, shared by the public
 * page reader, checkout and the pricing authority so they can't disagree (VAY-2134). The stored
 * content must parse as the exact published contract for its property, be bookable and fresh,
 * still be payable by its published methods (VAY-2139), and keep any custom domain verified.
 * `manualPayments` is whether bank-transfer and PayPal pages count.
 */
export async function visibleActiveBookingPublication(
  queryable: Queryable,
  row: ActiveBookingPublicationRow | undefined,
  context: { manualPayments: boolean },
): Promise<BookingPublicContent | null> {
  if (!row) return null;
  const parsed = parseBookingPublicContent(row.publicContent, context);
  const profile = parsed?.profile;
  if (
    !parsed ||
    !profile ||
    profile.hotel.propertyId !== row.propertyId ||
    profile.hotel.trust.bookabilityStatus !== "bookable" ||
    profile.freshness.status !== "fresh"
  )
    return null;
  // A bank-transfer or PayPal page stays up only while the hotel can still be paid that way.
  if (
    context.manualPayments &&
    !(await manualPublishedPagePayable(queryable, row.propertyId, parsed.payments.readyMethods))
  )
    return null;
  const customDomainUrl = profile.hotel.customDomainUrl;
  if (!customDomainUrl) return parsed;
  const domain = normalizedDomain(customDomainUrl);
  if (!domain) return null;
  const verified = await queryable.query(
    `SELECT 1
     FROM hotel_catalog.property_domains current_domain
     WHERE current_domain.property_id = $1::uuid
       AND current_domain.hostname = $2
       AND current_domain.verification_status = 'verified'
       AND current_domain.canonical_when_verified = TRUE`,
    [row.propertyId, domain],
  );
  return verified.rows.length ? parsed : null;
}

export type ActiveBookingPublicationGateConfig = Readonly<{
  /** PUBLIC_HOTEL_PROFILE_SOURCE=active_publication: the public site serves setup publications. */
  servesPublications: boolean;
  /** Bank-transfer and PayPal pages count only while their acceptance is on (VAY-2139). */
  manualPayments: boolean;
}>;

let gateConfig: ActiveBookingPublicationGateConfig = {
  servesPublications: false,
  manualPayments: false,
};

/** Set once at startup from the server config. Until the public site serves setup publications,
 * checkout and pricing keep reading only legacy bookability profiles, as the site does. */
export function configureActiveBookingPublicationGate(config: ActiveBookingPublicationGateConfig) {
  gateConfig = Object.freeze({ ...config });
}

export function activeBookingPublicationGateConfig(): ActiveBookingPublicationGateConfig {
  return gateConfig;
}

/** A hotel's booking addresses: its active canonical slug, and former ones that now redirect to it
 * (VAY-2295). Slugs are unique for good, so a former address never belongs to another hotel. */
export const hotelAddressSql = (row: string) =>
  `((${row}.purpose='canonical' AND ${row}.status='active')` +
  ` OR (${row}.purpose='redirect' AND ${row}.status='redirected'))`;

/** Whether the live page still sells under `slug`, an address of the property the caller has
 * already locked: the page must carry one of the hotel's addresses. Between an address change and
 * its republish the page carries the former one; open tabs keep either (VAY-2295). */
export async function publicationServesAddress(
  queryable: Queryable,
  propertyId: string,
  slug: string,
  content: BookingPublicContent | null,
): Promise<boolean> {
  const pageSlug = content?.profile.hotel.slug;
  if (!pageSlug) return false;
  if (pageSlug === slug) return true;
  const result = await queryable.query(
    `SELECT 1 FROM hotel_catalog.property_slugs s
     WHERE s.property_id=$1::uuid AND s.slug=$2 AND s.locale IS NULL AND ${hotelAddressSql("s")}
     FOR SHARE`,
    [propertyId, pageSlug],
  );
  return result.rows.length === 1;
}

/**
 * Locks the active Booking publication under one of a property's locale-less addresses (slug,
 * property, location, then the active row, like the legacy profile read) and says whether the
 * property has none, has one the public site hides, or has a visible one. A hotel that published
 * in setup is judged by its page, not by a legacy bookability profile (VAY-2134).
 */
export async function lockActiveBookingPublication(
  queryable: Queryable,
  slug: string,
  propertyId: string,
  context: { manualPayments: boolean },
): Promise<"absent" | "hidden" | "visible"> {
  const result = await queryable.query<ActiveBookingPublicationRow & { propertyActive: boolean }>(
    `SELECT active.property_id::text AS "propertyId", revision.public_content AS "publicContent",
            p.lifecycle_status='active' AS "propertyActive"
     FROM hotel_catalog.property_slugs s
     JOIN hotel_catalog.properties p ON p.id=s.property_id
     JOIN hotel_catalog.property_locations location ON location.property_id=p.id
     JOIN distribution.active_public_booking_revision active ON active.property_id=p.id
     JOIN distribution.public_booking_content_revisions revision
       ON revision.id=active.content_revision_id AND revision.property_id=active.property_id
     WHERE s.slug=$1 AND s.locale IS NULL AND s.property_id=$2::uuid AND ${hotelAddressSql("s")}
     FOR SHARE OF s,p,location,active`,
    [slug, propertyId],
  );
  const row = result.rows[0];
  if (!row) {
    const active = await queryable.query(
      "SELECT 1 FROM distribution.active_public_booking_revision WHERE property_id=$1::uuid",
      [propertyId],
    );
    return active.rows.length ? "hidden" : "absent";
  }
  if (result.rows.length !== 1 || row.propertyActive !== true) return "hidden";
  const content = await visibleActiveBookingPublication(queryable, row, context);
  return (await publicationServesAddress(queryable, propertyId, slug, content))
    ? "visible"
    : "hidden";
}

export const normalizedDomain = (value: string) => {
  try {
    const input = value.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      hostname &&
      !hostname.includes("..") &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
      ? hostname
      : null;
  } catch {
    return null;
  }
};
