import pg from "pg";
import {
  parseNearbyCurationState,
  projectNearbyPreview,
  type NearbyPreview,
  type PropertyProfileLocation,
} from "@vayada/domain-hotels";
import { nearbyOriginKey } from "../integrations/googleNearbyPlaces.js";
import { samePin } from "./propertyNearbyDiscoveryRepository.js";
import type { NearbyScope } from "./propertyNearbyRepository.js";

export type PublicNearby = NearbyPreview & {
  schemaVersion: 1;
  status: "ready" | "empty" | "unavailable" | "hidden" | "location_required" | "refreshing";
};
export type PublicNearbySnapshot = {
  scope: NearbyScope;
  revision: number;
  needsRefresh: boolean;
  public: PublicNearby;
};
export type PublicNearbyRepository = {
  read(propertyId: string): Promise<PublicNearbySnapshot | null>;
  close(): Promise<void>;
};

/** Catalog-owned projection. Live publication, tenancy and entitlement gates share one snapshot. */
export function createPgPublicNearbyRepository(
  connectionString: string,
  testClient?: pg.Client,
): PublicNearbyRepository {
  const pool = testClient ?? new pg.Pool({ connectionString });
  return {
    async read(propertyId) {
      const result = await pool.query(
        `
        SELECT p.profile_revision, catalog.organization_id,
          location.geo_public, location.map_display_mode,
          CASE WHEN location.geo_public AND location.map_display_mode='exact' THEN location.latitude
            WHEN location.geo_public AND location.map_display_mode='approximate' THEN round(location.latitude,2) END::double precision AS latitude,
          CASE WHEN location.geo_public AND location.map_display_mode='exact' THEN location.longitude
            WHEN location.geo_public AND location.map_display_mode='approximate' THEN round(location.longitude,2) END::double precision AS longitude,
          c.revision AS curation_revision, c.saved_profile_revision, c.saved_origin, c.choices, c.custom_places,
          c.custom_categories, c.category_names, settings.nearby_places_enabled
        FROM hotel_catalog.properties p
        JOIN distribution.active_public_booking_revision active ON active.property_id=p.id
        JOIN identity.organization_resource_links catalog ON catalog.resource_id=p.id::text
          AND catalog.product='hotel_catalog' AND catalog.resource_type='property'
          AND catalog.relationship IN ('owner','operator') AND catalog.status='active'
        JOIN identity.organizations org ON org.id=catalog.organization_id
          AND org.kind='hotel_group' AND org.status='active'
        JOIN identity.organization_resource_links booking ON booking.organization_id=org.id
          AND booking.resource_id=p.id::text AND booking.product='booking'
          AND booking.resource_type='booking_hotel' AND booking.relationship IN ('owner','operator')
          AND booking.status='active'
        LEFT JOIN hotel_catalog.property_locations location ON location.property_id=p.id
        LEFT JOIN hotel_catalog.property_nearby_curation c ON c.property_id=p.id
        LEFT JOIN booking.booking_settings settings ON settings.property_id=p.id
        WHERE p.id=$1::uuid AND p.lifecycle_status='active'
          AND EXISTS (SELECT 1 FROM identity.product_entitlements e
            WHERE e.organization_id=org.id AND e.product='booking' AND e.entitlement_key='booking-engine'
              AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=now())
              AND (e.expires_at IS NULL OR e.expires_at>now())
              AND (e.resource_product IS NULL OR (e.resource_product='booking'
                AND e.resource_type='booking_hotel' AND e.resource_id=p.id::text)))
          AND NOT EXISTS (SELECT 1 FROM identity.product_entitlements e
            WHERE e.organization_id=org.id AND e.product='booking' AND e.entitlement_key='booking-engine'
              AND e.status='suspended' AND (e.starts_at IS NULL OR e.starts_at<=now())
              AND (e.expires_at IS NULL OR e.expires_at>now())
              AND (e.resource_product IS NULL OR (e.resource_product='booking'
                AND e.resource_type='booking_hotel' AND e.resource_id=p.id::text)))
        ORDER BY catalog.organization_id LIMIT 1`,
        [propertyId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const revision = Number(row.profile_revision);
      // The same search origin the discovery and editor use (VAY-2104).
      const originKey =
        row.latitude === null || row.longitude === null
          ? null
          : nearbyOriginKey({ latitude: row.latitude, longitude: row.longitude });
      const curation = parseNearbyCurationState({
        schemaVersion: 1,
        profileRevision: revision,
        curationRevision: Number(row.curation_revision ?? 0),
        savedProfileRevision:
          row.saved_profile_revision === null
            ? null
            : samePin(row.saved_origin, originKey)
              ? revision
              : Number(row.saved_profile_revision),
        choices: row.choices ?? [],
        customPlaces: row.custom_places ?? [],
        customCategories: row.custom_categories ?? [],
        categoryNames: row.category_names ?? {},
      });
      // The host's "Show nearby places" switch (VAY-2326) hides every place at once, like a hidden location.
      const shown = row.nearby_places_enabled === true;
      const location: PropertyProfileLocation = {
        streetAddress: "",
        postalCode: "",
        city: "",
        countryCode: "",
        timezone: "",
        localityPublic: false,
        geoPublic: shown && row.geo_public === true,
        mapDisplayMode: row.map_display_mode ?? "hidden",
        latitude: row.latitude,
        longitude: row.longitude,
      };
      // v1 (VAY-2326, decision D5): guests see only the host's own places, so a guest view never starts a
      // paid Google lookup. Google places, and the lookup they need, come back with VAY-2207.
      const preview = projectNearbyPreview(location, revision, { ...curation, choices: [] }, null);
      const hidden = !location.geoPublic || location.mapDisplayMode === "hidden";
      return {
        scope: { propertyId, organizationId: row.organization_id },
        revision,
        needsRefresh: false,
        public: {
          schemaVersion: 1,
          ...preview,
          status: hidden
            ? "hidden"
            : !preview.location
              ? "location_required"
              : preview.places.length
                ? "ready"
                : "empty",
        },
      };
    },
    close: async () => {
      if (!testClient) await pool.end();
    },
  };
}
