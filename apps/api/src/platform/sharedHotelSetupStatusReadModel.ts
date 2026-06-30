import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  SharedHotelSetupEntryProduct,
  SharedHotelSetupStatusRepository,
  SharedProductActivation,
  SharedPropertyProfileMissingField,
  SharedSetupProperty,
} from "../routes/sharedHotelSetupStatus.js";

type SharedHotelSetupStatusPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type SharedHotelSetupRow = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  profileStatus: string | null;
  location: unknown;
  descriptions: unknown;
  media: unknown;
  publicContacts: unknown;
  bookingSelected: boolean;
  bookingSelectionUpdatedAt: unknown;
  hasBookingSettings: boolean;
  bookingSettingsUpdatedAt: unknown;
  bookingEntitlementActive: boolean;
  bookingEntitlementSuspended: boolean;
  bookingEntitlementUpdatedAt: unknown;
  bookabilityStatus: string | null;
  bookabilityFreshnessStatus: string | null;
  bookabilityUpdatedAt: unknown;
  paymentsEnabled: boolean | null;
  paymentSettingsUpdatedAt: unknown;
  pmsSelected: boolean;
  pmsSelectionUpdatedAt: unknown;
  pmsEntitlementActive: boolean;
  pmsEntitlementSuspended: boolean;
  pmsEntitlementUpdatedAt: unknown;
  pmsRoomTypeCount: number | string;
  pmsRoomUpdatedAt: unknown;
  pmsRoomCount: number | string;
  pmsRatePlanCount: number | string;
  pmsRateUpdatedAt: unknown;
  marketplaceSelected: boolean;
  marketplaceSelectionUpdatedAt: unknown;
  marketplaceEntitlementActive: boolean;
  marketplaceEntitlementSuspended: boolean;
  marketplaceEntitlementUpdatedAt: unknown;
  marketplaceProfileStatus: string | null;
  marketplaceProfileComplete: boolean | null;
  marketplaceProfileUpdatedAt: unknown;
  marketplaceListingCount: number | string;
  marketplaceVerifiedListingCount: number | string;
  marketplaceListingUpdatedAt: unknown;
  marketplaceOfferingCount: number | string;
  marketplaceOfferingUpdatedAt: unknown;
  marketplaceRequirementCount: number | string;
  marketplaceRequirementUpdatedAt: unknown;
};

type ProductSelectionRow = {
  product: SharedHotelSetupEntryProduct;
  updatedAt: unknown;
};

const PRODUCT_ORDER: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];

export function createPgSharedHotelSetupStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: SharedHotelSetupStatusPool;
}): SharedHotelSetupStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Shared hotel setup status repository connectionString must not be empty");
  }

  const ownsPool = config.pool === undefined;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async getHotelSetupStatus({ organizationId, propertyIds }) {
      const hotelGroup = await pool.query<{ displayName: string }>(
        `SELECT name AS "displayName"
         FROM identity.organizations
         WHERE id = $1::uuid
           AND kind = 'hotel_group'
           AND status = 'active'
         LIMIT 1`,
        [organizationId],
      );

      if (propertyIds.length === 0) {
        return {
          hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
          properties: [],
        };
      }

      const result = await pool.query<SharedHotelSetupRow>(sharedHotelSetupStatusSql(), [
        organizationId,
        propertyIds,
      ]);

      return {
        hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
        properties: result.rows.map(toSharedSetupProperty),
      };
    },
    async setPropertyProductSelections({ organizationId, propertyId, selectedProducts }) {
      const result = await pool.query<ProductSelectionRow>(propertyProductSelectionsSql(), [
        organizationId,
        propertyId,
        selectedProducts,
      ]);
      const selected = new Set(result.rows.map((row) => row.product));

      return {
        propertyId,
        selectedProducts: PRODUCT_ORDER.filter((product) => selected.has(product)),
        updatedAt: latest(...result.rows.map((row) => row.updatedAt)) ?? new Date().toISOString(),
      };
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

function toSharedSetupProperty(row: SharedHotelSetupRow): SharedSetupProperty {
  const sharedStatus = sharedProfileStatus(row.profileStatus);
  const missingFields = sharedStatus === "complete" ? [] : sharedProfileMissingFields(row);

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    displayName: nonEmpty(row.displayName),
    locationSummary: locationSummary(row.location),
    sharedProfile: {
      status: sharedStatus,
      completionPercent:
        sharedStatus === "complete" ? 100 : Math.round(((6 - missingFields.length) / 6) * 100),
      missingFields,
    },
    products: {
      booking: bookingActivation(row),
      pms: pmsActivation(row),
      marketplace: marketplaceActivation(row),
    },
  };
}

function sharedProfileStatus(value: string | null): SharedSetupProperty["sharedProfile"]["status"] {
  if (value === "complete" || value === "disabled" || value === "private") return value;
  return "incomplete";
}

function sharedProfileMissingFields(row: SharedHotelSetupRow): SharedPropertyProfileMissingField[] {
  const missing: SharedPropertyProfileMissingField[] = [];
  if (!nonEmpty(row.displayName)) missing.push("displayName");
  if (!hasLocation(row.location)) missing.push("location");
  if (!hasContact(row.publicContacts, ["website"])) missing.push("website");
  if (!hasContact(row.publicContacts, ["phone", "whatsapp"])) missing.push("phone");
  if (!hasDescription(row.descriptions)) missing.push("description");
  if (!hasMedia(row.media)) missing.push("media");
  return missing;
}

function bookingActivation(row: SharedHotelSetupRow): SharedProductActivation<"booking"> {
  if (!row.bookingSelected) return notSelected("booking");
  if (row.bookingEntitlementSuspended) {
    return productActivation(
      "booking",
      "suspended",
      [],
      ["booking_suspended"],
      row.bookingEntitlementUpdatedAt,
    );
  }
  if (row.bookabilityStatus === "unavailable") {
    return productActivation(
      "booking",
      "unavailable",
      [],
      ["booking_unavailable"],
      row.bookabilityUpdatedAt,
    );
  }

  const missingSteps: string[] = [];
  if (!row.bookingEntitlementActive) missingSteps.push("productEntitlement");
  if (!row.hasBookingSettings) missingSteps.push("bookingSettings");
  if (row.bookabilityStatus !== "public") missingSteps.push("publicBookability");
  if (row.bookabilityStatus === "public" && row.bookabilityFreshnessStatus !== "fresh") {
    missingSteps.push("bookabilityFreshness");
  }
  if (row.paymentsEnabled !== true) missingSteps.push("paymentReadiness");

  return missingSteps.length === 0
    ? productActivation(
        "booking",
        "active",
        [],
        [],
        latest(
          row.bookingSelectionUpdatedAt,
          row.bookingSettingsUpdatedAt,
          row.bookabilityUpdatedAt,
          row.paymentSettingsUpdatedAt,
          row.bookingEntitlementUpdatedAt,
        ),
      )
    : productActivation(
        "booking",
        "selected_incomplete",
        missingSteps,
        ["booking_activation_incomplete"],
        latest(
          row.bookingSelectionUpdatedAt,
          row.bookingSettingsUpdatedAt,
          row.bookabilityUpdatedAt,
          row.paymentSettingsUpdatedAt,
          row.bookingEntitlementUpdatedAt,
        ),
      );
}

function pmsActivation(row: SharedHotelSetupRow): SharedProductActivation<"pms"> {
  const roomTypes = toCount(row.pmsRoomTypeCount);
  const rooms = toCount(row.pmsRoomCount);
  const ratePlans = toCount(row.pmsRatePlanCount);
  if (!row.pmsSelected) return notSelected("pms");
  if (row.pmsEntitlementSuspended) {
    return productActivation(
      "pms",
      "suspended",
      [],
      ["pms_suspended"],
      row.pmsEntitlementUpdatedAt,
    );
  }

  const missingSteps: string[] = [];
  if (!row.pmsEntitlementActive) missingSteps.push("productEntitlement");
  if (roomTypes === 0) missingSteps.push("roomTypes");
  if (rooms === 0) missingSteps.push("rooms");
  if (ratePlans === 0) missingSteps.push("ratePlans");

  return missingSteps.length === 0
    ? productActivation(
        "pms",
        "active",
        [],
        [],
        latest(
          row.pmsSelectionUpdatedAt,
          row.pmsRoomUpdatedAt,
          row.pmsRateUpdatedAt,
          row.pmsEntitlementUpdatedAt,
        ),
      )
    : productActivation(
        "pms",
        "selected_incomplete",
        missingSteps,
        ["pms_activation_incomplete"],
        latest(
          row.pmsSelectionUpdatedAt,
          row.pmsRoomUpdatedAt,
          row.pmsRateUpdatedAt,
          row.pmsEntitlementUpdatedAt,
        ),
      );
}

function marketplaceActivation(row: SharedHotelSetupRow): SharedProductActivation<"marketplace"> {
  if (!row.marketplaceSelected) return notSelected("marketplace");
  if (row.marketplaceEntitlementSuspended) {
    return productActivation(
      "marketplace",
      "suspended",
      [],
      ["marketplace_suspended"],
      row.marketplaceEntitlementUpdatedAt,
    );
  }
  if (row.marketplaceProfileStatus === "suspended") {
    return productActivation(
      "marketplace",
      "suspended",
      [],
      ["marketplace_suspended"],
      row.marketplaceProfileUpdatedAt,
    );
  }
  if (row.marketplaceProfileStatus === "rejected" || row.marketplaceProfileStatus === "archived") {
    return productActivation(
      "marketplace",
      "unavailable",
      [],
      ["marketplace_unavailable"],
      row.marketplaceProfileUpdatedAt,
    );
  }

  const missingSteps: string[] = [];
  if (!row.marketplaceEntitlementActive) missingSteps.push("productEntitlement");
  if (row.marketplaceProfileComplete !== true) missingSteps.push("creatorPitch");
  if (
    toCount(row.marketplaceVerifiedListingCount) === 0 ||
    toCount(row.marketplaceOfferingCount) === 0
  ) {
    missingSteps.push("collaborationOffer");
  }
  if (toCount(row.marketplaceRequirementCount) === 0) missingSteps.push("creatorRequirements");

  return missingSteps.length === 0 && row.marketplaceProfileStatus === "verified"
    ? productActivation("marketplace", "active", [], [], marketplaceUpdatedAt(row))
    : productActivation(
        "marketplace",
        "selected_incomplete",
        unique(missingSteps),
        ["marketplace_activation_incomplete"],
        marketplaceUpdatedAt(row),
      );
}

function notSelected<Product extends SharedHotelSetupEntryProduct>(
  product: Product,
): SharedProductActivation<Product> {
  return { product, status: "not_selected", missingSteps: [], statusReasons: [], updatedAt: null };
}

function productActivation<Product extends SharedHotelSetupEntryProduct>(
  product: Product,
  status: SharedProductActivation<Product>["status"],
  missingSteps: string[],
  statusReasons: string[],
  updatedAt: unknown,
): SharedProductActivation<Product> {
  return { product, status, missingSteps, statusReasons, updatedAt: toIsoString(updatedAt) };
}

function marketplaceUpdatedAt(row: SharedHotelSetupRow): string | null {
  return latest(
    row.marketplaceSelectionUpdatedAt,
    row.marketplaceEntitlementUpdatedAt,
    row.marketplaceProfileUpdatedAt,
    row.marketplaceListingUpdatedAt,
    row.marketplaceOfferingUpdatedAt,
    row.marketplaceRequirementUpdatedAt,
  );
}

function sharedHotelSetupStatusSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      COALESCE(public_profile.public_id, property.public_id) AS "publicId",
      COALESCE(public_profile.display_name, property.display_name) AS "displayName",
      COALESCE(public_profile.profile_status, property.profile_status) AS "profileStatus",
      COALESCE(public_profile.location, '{}'::jsonb) AS "location",
      COALESCE(public_profile.descriptions, '{}'::jsonb) AS "descriptions",
      COALESCE(public_profile.media, '[]'::jsonb) AS "media",
      COALESCE(public_profile.public_contacts, '[]'::jsonb) AS "publicContacts",
      booking_selection.id IS NOT NULL AS "bookingSelected",
      booking_selection.updated_at AS "bookingSelectionUpdatedAt",
      booking_settings.property_id IS NOT NULL AS "hasBookingSettings",
      booking_settings.updated_at AS "bookingSettingsUpdatedAt",
      COALESCE(booking_entitlement.active, FALSE) AS "bookingEntitlementActive",
      COALESCE(booking_entitlement.suspended, FALSE) AS "bookingEntitlementSuspended",
      booking_entitlement.updated_at AS "bookingEntitlementUpdatedAt",
      bookability.profile_status AS "bookabilityStatus",
      bookability.freshness_status AS "bookabilityFreshnessStatus",
      bookability.updated_at AS "bookabilityUpdatedAt",
      payment_settings.payments_enabled AS "paymentsEnabled",
      payment_settings.updated_at AS "paymentSettingsUpdatedAt",
      pms_selection.id IS NOT NULL AS "pmsSelected",
      pms_selection.updated_at AS "pmsSelectionUpdatedAt",
      COALESCE(pms_entitlement.active, FALSE) AS "pmsEntitlementActive",
      COALESCE(pms_entitlement.suspended, FALSE) AS "pmsEntitlementSuspended",
      pms_entitlement.updated_at AS "pmsEntitlementUpdatedAt",
      COALESCE(pms_room_types.count, 0) AS "pmsRoomTypeCount",
      pms_room_types.updated_at AS "pmsRoomUpdatedAt",
      COALESCE(pms_rooms.count, 0) AS "pmsRoomCount",
      COALESCE(pms_rate_plans.count, 0) AS "pmsRatePlanCount",
      pms_rate_plans.updated_at AS "pmsRateUpdatedAt",
      marketplace_selection.id IS NOT NULL AS "marketplaceSelected",
      marketplace_selection.updated_at AS "marketplaceSelectionUpdatedAt",
      COALESCE(marketplace_entitlement.active, FALSE) AS "marketplaceEntitlementActive",
      COALESCE(marketplace_entitlement.suspended, FALSE) AS "marketplaceEntitlementSuspended",
      marketplace_entitlement.updated_at AS "marketplaceEntitlementUpdatedAt",
      marketplace_profile.marketplace_profile_status AS "marketplaceProfileStatus",
      marketplace_profile.profile_complete AS "marketplaceProfileComplete",
      marketplace_profile.updated_at AS "marketplaceProfileUpdatedAt",
      COALESCE(marketplace_listings.count, 0) AS "marketplaceListingCount",
      COALESCE(marketplace_listings.verified_count, 0) AS "marketplaceVerifiedListingCount",
      marketplace_listings.updated_at AS "marketplaceListingUpdatedAt",
      COALESCE(marketplace_offerings.count, 0) AS "marketplaceOfferingCount",
      marketplace_offerings.updated_at AS "marketplaceOfferingUpdatedAt",
      COALESCE(marketplace_requirements.count, 0) AS "marketplaceRequirementCount",
      marketplace_requirements.updated_at AS "marketplaceRequirementUpdatedAt"
    FROM unnest($2::uuid[]) AS scoped(property_id)
    JOIN hotel_catalog.properties property
      ON property.id = scoped.property_id
    LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
      ON public_profile.property_id = property.id
    LEFT JOIN hotel_catalog.property_product_selections booking_selection
      ON booking_selection.organization_id = $1::uuid
     AND booking_selection.property_id = property.id
     AND booking_selection.product = 'booking'
     AND booking_selection.status = 'selected'
    LEFT JOIN booking.booking_settings booking_settings
      ON booking_settings.property_id = property.id
    LEFT JOIN distribution.public_hotel_bookability_profiles bookability
      ON bookability.property_id = property.id
    LEFT JOIN finance.payment_settings payment_settings
      ON payment_settings.property_id = property.id
    LEFT JOIN hotel_catalog.property_product_selections pms_selection
      ON pms_selection.organization_id = $1::uuid
     AND pms_selection.property_id = property.id
     AND pms_selection.product = 'pms'
     AND pms_selection.status = 'selected'
    LEFT JOIN LATERAL (
      SELECT
        bool_or(
          status = 'active'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS active,
        bool_or(
          status = 'suspended'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS suspended,
        max(updated_at) AS updated_at
      FROM identity.product_entitlements
      WHERE organization_id = $1::uuid
        AND product = 'booking'
        AND (
          resource_product IS NULL
          OR (
            resource_id = property.id::text
            AND (
              (resource_product = 'hotel_catalog' AND resource_type = 'property')
              OR (resource_product = 'booking' AND resource_type = 'booking_hotel')
            )
          )
        )
    ) booking_entitlement ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        bool_or(
          status = 'active'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS active,
        bool_or(
          status = 'suspended'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS suspended,
        max(updated_at) AS updated_at
      FROM identity.product_entitlements
      WHERE organization_id = $1::uuid
        AND product = 'pms'
        AND (
          resource_product IS NULL
          OR (
            resource_id = property.id::text
            AND (
              (resource_product = 'hotel_catalog' AND resource_type = 'property')
              OR (resource_product = 'pms' AND resource_type IN ('pms_property', 'pms_hotel'))
            )
          )
        )
    ) pms_entitlement ON TRUE
    LEFT JOIN hotel_catalog.property_product_selections marketplace_selection
      ON marketplace_selection.organization_id = $1::uuid
     AND marketplace_selection.property_id = property.id
     AND marketplace_selection.product = 'marketplace'
     AND marketplace_selection.status = 'selected'
    LEFT JOIN LATERAL (
      SELECT
        bool_or(
          status = 'active'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS active,
        bool_or(
          status = 'suspended'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (expires_at IS NULL OR expires_at > now())
        ) AS suspended,
        max(updated_at) AS updated_at
      FROM identity.product_entitlements
      WHERE organization_id = $1::uuid
        AND product = 'marketplace'
        AND (
          resource_product IS NULL
          OR (
            resource_id = property.id::text
            AND (
              (resource_product = 'hotel_catalog' AND resource_type = 'property')
              OR (resource_product = 'marketplace' AND resource_type IN ('hotel_profile', 'hotel_listing'))
            )
          )
        )
    ) marketplace_entitlement ON TRUE
    LEFT JOIN marketplace.marketplace_hotel_profiles marketplace_profile
      ON marketplace_profile.property_id = property.id
     AND marketplace_profile.organization_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.room_types
      WHERE property_id = property.id
        AND active = TRUE
    ) pms_room_types ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.rooms
      WHERE property_id = property.id
        AND status <> 'retired'
    ) pms_rooms ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(updated_at) AS updated_at
      FROM pms.rate_plans
      WHERE property_id = property.id
        AND active = TRUE
    ) pms_rate_plans ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS count,
        count(*) FILTER (WHERE listing_status = 'verified')::int AS verified_count,
        max(updated_at) AS updated_at
      FROM marketplace.marketplace_hotel_listings
      WHERE property_id = property.id
        AND organization_id = $1::uuid
        AND listing_status <> 'archived'
    ) marketplace_listings ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(offering.updated_at) AS updated_at
      FROM marketplace.listing_collaboration_offerings offering
      JOIN marketplace.marketplace_hotel_listings listing
        ON listing.id = offering.listing_id
       AND listing.property_id = offering.property_id
       AND listing.organization_id = offering.organization_id
      WHERE offering.property_id = property.id
        AND offering.organization_id = $1::uuid
        AND listing.listing_status <> 'archived'
    ) marketplace_offerings ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, max(requirement.updated_at) AS updated_at
      FROM marketplace.listing_creator_requirements requirement
      JOIN marketplace.marketplace_hotel_listings listing
        ON listing.id = requirement.listing_id
       AND listing.property_id = requirement.property_id
       AND listing.organization_id = requirement.organization_id
      WHERE requirement.property_id = property.id
        AND requirement.organization_id = $1::uuid
        AND listing.listing_status <> 'archived'
    ) marketplace_requirements ON TRUE
    ORDER BY array_position($2::uuid[], property.id)
  `;
}

function propertyProductSelectionsSql(): string {
  return `
    WITH requested(product) AS (
      SELECT DISTINCT unnest($3::text[])
    ),
    upserted AS (
      INSERT INTO hotel_catalog.property_product_selections
        (organization_id, property_id, product, status)
      SELECT $1::uuid, $2::uuid, product, 'selected'
      FROM requested
      ON CONFLICT (organization_id, property_id, product)
      DO UPDATE SET status = 'selected', updated_at = now()
      RETURNING product, updated_at
    ),
    unselected AS (
      UPDATE hotel_catalog.property_product_selections
      SET status = 'unselected', updated_at = now()
      WHERE organization_id = $1::uuid
        AND property_id = $2::uuid
        AND status = 'selected'
        AND NOT (product = ANY($3::text[]))
      RETURNING product, updated_at
    ),
    selected_after_write AS (
      SELECT product, updated_at
      FROM upserted
      UNION ALL
      SELECT product, updated_at
      FROM unselected
      WHERE FALSE
    )
    SELECT product, updated_at
    FROM selected_after_write
    ORDER BY CASE product
      WHEN 'booking' THEN 1
      WHEN 'pms' THEN 2
      WHEN 'marketplace' THEN 3
      ELSE 4
    END
  `;
}

function hasLocation(value: unknown): boolean {
  const location = objectValue(value);
  return ["rawMarketplaceLocation", "city", "countryCode"].some((key) => nonEmpty(location[key]));
}

function locationSummary(value: unknown): string | null {
  const location = objectValue(value);
  const parts = [location["city"], location["region"], location["countryCode"]]
    .map((item) => nonEmpty(item))
    .filter((item): item is string => item !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function hasDescription(value: unknown): boolean {
  const descriptions = objectValue(value);
  return ["shortDescription", "longDescription", "short_description", "long_description"].some(
    (key) => nonEmpty(descriptions[key]),
  );
}

function hasMedia(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasContact(value: unknown, types: string[]): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const contact = objectValue(entry);
    const type = nonEmpty(contact["type"] ?? contact["channelType"] ?? contact["channel_type"]);
    const contactValue = nonEmpty(contact["value"]);
    return Boolean(type && contactValue && types.includes(type));
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toCount(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10) || 0;
}

function latest(...values: unknown[]): string | null {
  const timestamps = values
    .map((value) => {
      const iso = toIsoString(value);
      return iso ? Date.parse(iso) : Number.NaN;
    })
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
