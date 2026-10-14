import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import pg, { type QueryResultRow } from "pg";

import {
  ACTIVE_BOOKING_PUBLICATION_CONTRACT,
  normalizedDomain,
  visibleActiveBookingPublication,
  type ActiveBookingPublicationRow,
} from "../domains/activeBookingPublicationGate.js";
import {
  createTargetPublicHotelProfileRepository,
  type PublicHotelProfileReadPool,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";

type CurrentPublicGatesRow = QueryResultRow & {
  referralEnabled: boolean;
  latitude: number | null;
  longitude: number | null;
};

const ACTIVE_PROFILE_SELECT = `SELECT
  active.property_id::text AS "propertyId",
  revision.public_content AS "publicContent"
FROM distribution.active_public_booking_revision active
JOIN distribution.public_booking_content_revisions revision
  ON revision.id = active.content_revision_id
 AND revision.property_id = active.property_id
WHERE revision.public_content ->> 'contractVersion' = '${ACTIVE_BOOKING_PUBLICATION_CONTRACT}'`;

export function createActiveBookingPublicationProfileRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PublicHotelProfileReadPool;
  /** Bank-transfer and PayPal pages count only while their acceptance is on (VAY-2139). */
  manualPayments?: boolean;
}): PublicHotelProfileRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Active Booking publication profile connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const content = { manualPayments: config.manualPayments === true };
  // A hotel that never published in setup keeps the page it had before the public site switched to
  // setup publications, as checkout and pricing already do. Once it publishes, only its
  // publication counts, even while that is hidden. Only the legacy publisher writes those
  // profiles and it doesn't run in this mode, so this is the set that was online at the switch,
  // less hotels suspended or retired since (VAY-2186).
  const legacy = createTargetPublicHotelProfileRepository({
    connectionString: config.connectionString,
    pool,
    unpublishedOnly: true,
  });

  return {
    async findProfileBySlug(value) {
      const slug = normalizedSlug(value);
      if (!slug) return null;
      const result = await pool.query<ActiveBookingPublicationRow>(
        `${ACTIVE_PROFILE_SELECT}
         AND (
           lower(revision.public_content #>> '{profile,hotel,slug}') = $1
           OR EXISTS (
             SELECT 1
             FROM hotel_catalog.property_slugs redirect
             WHERE redirect.property_id = active.property_id
               AND redirect.slug = $1
               AND redirect.purpose = 'redirect'
               AND redirect.status = 'redirected'
           )
         )
         ORDER BY CASE
           WHEN lower(revision.public_content #>> '{profile,hotel,slug}') = $1 THEN 0
           ELSE 1
         END
         LIMIT 1`,
        [slug],
      );
      const row = result.rows[0];
      if (!row) return legacy.findProfileBySlug(slug);
      return currentActiveProfile(pool, row, content);
    },

    async findProfileByCustomDomain(value) {
      const domain = normalizedDomain(value);
      if (!domain) return null;
      const result = await pool.query<ActiveBookingPublicationRow>(
        `${ACTIVE_PROFILE_SELECT}
         AND EXISTS (
           SELECT 1
           FROM hotel_catalog.property_domains current_domain
           WHERE current_domain.property_id = active.property_id
             AND current_domain.hostname = $1
             AND current_domain.verification_status = 'verified'
             AND current_domain.canonical_when_verified = TRUE
         )
         LIMIT 1`,
        [domain],
      );
      const row = result.rows[0];
      if (!row) return (await legacy.findProfileByCustomDomain?.(domain)) ?? null;
      const profile = await currentActiveProfile(pool, row, content);
      return profile && normalizedDomain(profile.hotel.customDomainUrl ?? "") === domain
        ? profile
        : null;
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function currentActiveProfile(
  pool: PublicHotelProfileReadPool,
  row: ActiveBookingPublicationRow | undefined,
  content: { manualPayments: boolean },
): Promise<PublicBookabilityProfileProjection | null> {
  const parsed = await visibleActiveBookingPublication(pool, row, content);
  if (!parsed || !row) return null;
  const profile = parsed.profile;
  const result = await pool.query<CurrentPublicGatesRow>(
    `SELECT
       (SELECT CASE WHEN geo_public AND map_display_mode='exact' THEN latitude
         WHEN geo_public AND map_display_mode='approximate' THEN round(latitude,2) END::double precision
         FROM hotel_catalog.property_locations WHERE property_id=$1::uuid
           AND latitude IS NOT NULL AND longitude IS NOT NULL) AS latitude,
       (SELECT CASE WHEN geo_public AND map_display_mode='exact' THEN longitude
         WHEN geo_public AND map_display_mode='approximate' THEN round(longitude,2) END::double precision
         FROM hotel_catalog.property_locations WHERE property_id=$1::uuid
           AND latitude IS NOT NULL AND longitude IS NOT NULL) AS longitude,
       EXISTS (
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.product = 'pms'
           AND entitlement.entitlement_key = 'module:affiliates'
           AND entitlement.status = 'active'
           AND entitlement.resource_product = 'pms'
           AND entitlement.resource_type = 'pms_property'
           AND entitlement.resource_id = $1::text
           AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
           AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
           AND EXISTS (
             SELECT 1
             FROM identity.organization_resource_links pms_resource
             WHERE pms_resource.organization_id = entitlement.organization_id
               AND pms_resource.product = 'pms'
               AND pms_resource.resource_type = 'pms_property'
               AND pms_resource.resource_id = $1::text
               AND pms_resource.relationship IN ('owner', 'operator')
               AND pms_resource.status = 'active'
           )
           AND EXISTS (
             SELECT 1
             FROM identity.organization_resource_links booking_resource
             WHERE booking_resource.organization_id = entitlement.organization_id
               AND booking_resource.product = 'booking'
               AND booking_resource.resource_type = 'booking_hotel'
               AND booking_resource.resource_id = $1::text
               AND booking_resource.relationship IN ('owner', 'operator')
               AND booking_resource.status = 'active'
           )
       ) AS "referralEnabled"`,
    [row.propertyId],
  );
  const gates = result.rows[0];
  const referralEnabled = gates?.referralEnabled === true;
  const branding = profile.hotel.branding;
  return {
    ...profile,
    hotel: {
      ...profile.hotel,
      location: {
        ...profile.hotel.location,
        latitude: gates?.latitude ?? null,
        longitude: gates?.longitude ?? null,
      },
      capabilities: {
        ...profile.hotel.capabilities,
        referralCodes: profile.hotel.capabilities.referralCodes && referralEnabled,
      },
      ...(branding
        ? {
            branding: {
              ...branding,
              showReferAGuestButton: branding.showReferAGuestButton === true && referralEnabled,
            },
          }
        : {}),
    },
  };
}

const normalizedSlug = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
};
