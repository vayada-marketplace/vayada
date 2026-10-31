import type { ManualPricingPaymentMethod } from "@vayada/domain-booking";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import pg, { type QueryResultRow } from "pg";
import { LIVE_PROMO_CODES_SQL } from "../domains/bookingGuestModules.js";

import {
  ACTIVE_BOOKING_PUBLICATION_CONTRACT,
  normalizedDomain,
  visibleActiveBookingPublication,
  type ActiveBookingPublicationRow,
  type ManualPaymentPagesContext,
} from "../domains/activeBookingPublicationGate.js";
import {
  createTargetPublicHotelProfileRepository,
  type PublicHotelProfileReadPool,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";

type CurrentPublicGatesRow = QueryResultRow & {
  promoCodes: boolean;
  latitude: number | null;
  longitude: number | null;
  displayCurrencies: string[] | null;
  displayDefaultCurrency: string | null;
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
  /** Bank-transfer and PayPal pages count only while their acceptance is on (VAY-2139), for the
   * manual methods the booking page takes now (replacementPricingManualPaymentMethods). */
  manualPayments?: boolean;
  manualMethods?: readonly ManualPricingPaymentMethod[];
}): PublicHotelProfileRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Active Booking publication profile connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const content: ManualPaymentPagesContext = {
    manualPayments: config.manualPayments === true,
    manualMethods: config.manualMethods ?? [],
  };
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
  content: ManualPaymentPagesContext,
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
       ${LIVE_PROMO_CODES_SQL("$1::uuid")} AS "promoCodes",
       (SELECT supported_currencies FROM booking.booking_settings
         WHERE property_id=$1::uuid) AS "displayCurrencies",
       (SELECT default_currency::text FROM booking.booking_settings
         WHERE property_id=$1::uuid) AS "displayDefaultCurrency"`,
    [row.propertyId],
  );
  const gates = result.rows[0];
  const branding = profile.hotel.branding;
  // Live, not from the publication, which never carried them (VAY-2345): the currencies Booking
  // settings add for display, after the hotel's own. Quotes and charges stay in that currency.
  // VAY-2390: Localization's guest display currency is offered too, and guests see it first.
  const rawDisplayDefault = gates?.displayDefaultCurrency ?? "";
  const displayDefault = /^[A-Z]{3}$/.test(rawDisplayDefault) ? rawDisplayDefault : null;
  const displayCurrencies = [
    ...new Set([
      profile.hotel.defaultCurrency,
      ...(displayDefault ? [displayDefault] : []),
      ...(gates?.displayCurrencies ?? []).filter((code) => /^[A-Z]{3}$/.test(code)),
    ]),
  ];
  const showsDisplayDefault =
    displayDefault !== null && displayDefault !== profile.hotel.defaultCurrency;
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
        referralCodes: false,
        // Live, not from the publication: the Promos switch (VAY-2200) and codes made later.
        promoCodes: gates?.promoCodes === true,
      },
      ...(branding
        ? {
            branding: {
              ...branding,
              showReferAGuestButton: false,
              ...(displayCurrencies.length > 1 ? { displayCurrencies } : {}),
              ...(showsDisplayDefault ? { displayDefaultCurrency: displayDefault } : {}),
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
