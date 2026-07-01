import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  SharedHotelSetupEntryProduct,
  SharedHotelSetupStatusRepository,
  SharedPropertyProfile,
  SharedPropertyProfileInput,
  SharedPropertyProfileLocation,
  SharedPropertyProfileMedia,
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

type SharedPropertyProfileRow = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  profileStatus: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  rawMarketplaceLocation: string | null;
  timezone: string | null;
  latitude: unknown;
  longitude: unknown;
  addressPublic: boolean | null;
  mapDisplayMode: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  website: string | null;
  phone: string | null;
  media: unknown;
  updatedAt: unknown;
};

type PropertyProfileWriteRow = {
  propertyId: string;
};

type SharedPropertyProfileWritePayload = {
  display_name: string;
  country_code: string | null;
  region: string | null;
  city: string | null;
  street_address: string | null;
  postal_code: string | null;
  raw_marketplace_location: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  address_public: boolean;
  map_display_mode: SharedPropertyProfileLocation["mapDisplayMode"];
  short_description: string | null;
  long_description: string | null;
  website: string | null;
  phone: string | null;
  media: Array<{
    media_type: SharedPropertyProfileMedia["mediaType"];
    url: string;
    alt_text: string | null;
    sort_order: number;
  }>;
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
    async getPropertyProfile({ organizationId, propertyId }) {
      return loadPropertyProfile(pool, organizationId, propertyId);
    },
    async createPropertyProfile({ organizationId, profile }) {
      const propertyId = await writePropertyProfile(pool, {
        organizationId,
        profile,
        mode: "create",
      });
      if (!propertyId) {
        throw new Error("Created shared property profile did not return a property id");
      }
      const created = await loadPropertyProfile(pool, organizationId, propertyId);
      if (!created) {
        throw new Error("Created shared property profile could not be loaded");
      }
      return created;
    },
    async updatePropertyProfile({ organizationId, propertyId, profile }) {
      const updatedPropertyId = await writePropertyProfile(pool, {
        organizationId,
        propertyId,
        profile,
        mode: "update",
      });
      if (!updatedPropertyId) return null;
      return loadPropertyProfile(pool, organizationId, updatedPropertyId);
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

async function loadPropertyProfile(
  pool: SharedHotelSetupStatusPool,
  organizationId: string,
  propertyId: string,
): Promise<SharedPropertyProfile | null> {
  const result = await pool.query<SharedPropertyProfileRow>(propertyProfileSql(), [
    organizationId,
    propertyId,
  ]);
  const row = result.rows[0];
  return row ? toSharedPropertyProfile(row) : null;
}

async function writePropertyProfile(
  pool: SharedHotelSetupStatusPool,
  input:
    | { mode: "create"; organizationId: string; profile: SharedPropertyProfileInput }
    | {
        mode: "update";
        organizationId: string;
        propertyId: string;
        profile: SharedPropertyProfileInput;
      },
): Promise<string | null> {
  const missingFields = profileInputMissingFields(input.profile);
  const profileStatus = missingFields.length === 0 ? "complete" : "incomplete";
  const payload = propertyProfileWritePayload(input.profile);
  const result =
    input.mode === "create"
      ? await pool.query<PropertyProfileWriteRow>(createPropertyProfileSql(), [
          input.organizationId,
          payload,
          profileStatus,
          missingFields,
        ])
      : await pool.query<PropertyProfileWriteRow>(updatePropertyProfileSql(), [
          input.organizationId,
          input.propertyId,
          payload,
          profileStatus,
          missingFields,
        ]);

  return result.rows[0]?.propertyId ?? null;
}

function toSharedPropertyProfile(row: SharedPropertyProfileRow): SharedPropertyProfile {
  const media = mediaItems(row.media);
  const profile: SharedPropertyProfileInput = {
    displayName: nonEmpty(row.displayName) ?? "",
    location: {
      countryCode: nonEmpty(row.countryCode),
      region: nonEmpty(row.region),
      city: nonEmpty(row.city),
      streetAddress: nonEmpty(row.streetAddress),
      postalCode: nonEmpty(row.postalCode),
      rawMarketplaceLocation: nonEmpty(row.rawMarketplaceLocation),
      timezone: nonEmpty(row.timezone),
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      addressPublic: row.addressPublic ?? true,
      mapDisplayMode: mapDisplayMode(row.mapDisplayMode),
    },
    website: nonEmpty(row.website),
    phone: nonEmpty(row.phone),
    shortDescription: nonEmpty(row.shortDescription),
    longDescription: nonEmpty(row.longDescription),
    media,
  };
  const computedMissingFields = profileInputMissingFields(profile);
  const status = sharedProfileStatus(row.profileStatus, computedMissingFields);
  const missingFields = status === "complete" ? [] : computedMissingFields;

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    ...profile,
    sharedProfile: {
      status,
      completionPercent: completionPercent(missingFields),
      missingFields,
    },
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  };
}

function toSharedSetupProperty(row: SharedHotelSetupRow): SharedSetupProperty {
  const computedMissingFields = sharedProfileMissingFields(row);
  const sharedStatus = sharedProfileStatus(row.profileStatus, computedMissingFields);
  const missingFields = sharedStatus === "complete" ? [] : computedMissingFields;

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    displayName: nonEmpty(row.displayName),
    locationSummary: locationSummary(row.location),
    sharedProfile: {
      status: sharedStatus,
      completionPercent: completionPercent(missingFields),
      missingFields,
    },
    products: {
      booking: bookingActivation(row),
      pms: pmsActivation(row),
      marketplace: marketplaceActivation(row),
    },
  };
}

function sharedProfileStatus(
  value: string | null,
  missingFields: SharedPropertyProfileMissingField[],
): SharedSetupProperty["sharedProfile"]["status"] {
  if (value === "disabled" || value === "private") return value;
  return missingFields.length === 0 ? "complete" : "incomplete";
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

function profileInputMissingFields(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfileMissingField[] {
  const missing: SharedPropertyProfileMissingField[] = [];
  if (!nonEmpty(profile.displayName)) missing.push("displayName");
  if (!hasProfileLocation(profile.location)) missing.push("location");
  if (!nonEmpty(profile.website)) missing.push("website");
  if (!nonEmpty(profile.phone)) missing.push("phone");
  if (!nonEmpty(profile.shortDescription) && !nonEmpty(profile.longDescription)) {
    missing.push("description");
  }
  if (profile.media.length === 0) missing.push("media");
  return missing;
}

function hasProfileLocation(location: SharedPropertyProfileLocation): boolean {
  return [location.rawMarketplaceLocation, location.city, location.countryCode].some(
    (value) => nonEmpty(value) !== null,
  );
}

function completionPercent(missingFields: SharedPropertyProfileMissingField[]): number {
  return missingFields.length === 0 ? 100 : Math.round(((6 - missingFields.length) / 6) * 100);
}

function propertyProfileWritePayload(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfileWritePayload {
  return {
    display_name: profile.displayName,
    country_code: profile.location.countryCode,
    region: profile.location.region,
    city: profile.location.city,
    street_address: profile.location.streetAddress,
    postal_code: profile.location.postalCode,
    raw_marketplace_location: profile.location.rawMarketplaceLocation,
    timezone: profile.location.timezone,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    address_public: profile.location.addressPublic,
    map_display_mode: profile.location.mapDisplayMode,
    short_description: profile.shortDescription,
    long_description: profile.longDescription,
    website: profile.website,
    phone: profile.phone,
    media: profile.media.map((item) => ({
      media_type: item.mediaType,
      url: item.url,
      alt_text: item.altText,
      sort_order: item.sortOrder,
    })),
  };
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
  const listingCount = toCount(row.marketplaceListingCount);
  const verifiedListingCount = toCount(row.marketplaceVerifiedListingCount);
  const offeringCount = toCount(row.marketplaceOfferingCount);
  if (!row.marketplaceEntitlementActive) missingSteps.push("productEntitlement");
  if (row.marketplaceProfileComplete !== true) missingSteps.push("creatorPitch");
  if (listingCount === 0) missingSteps.push("marketplaceListing");
  if (verifiedListingCount === 0 || offeringCount === 0) {
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

function propertyProfileSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.public_id AS "publicId",
      property.display_name AS "displayName",
      property.profile_status AS "profileStatus",
      location.country_code AS "countryCode",
      location.region,
      location.city,
      location.street_address AS "streetAddress",
      location.postal_code AS "postalCode",
      location.raw_marketplace_location AS "rawMarketplaceLocation",
      location.timezone,
      location.latitude,
      location.longitude,
      location.address_public AS "addressPublic",
      location.map_display_mode AS "mapDisplayMode",
      profile.short_description AS "shortDescription",
      profile.long_description AS "longDescription",
      contact.website,
      contact.phone,
      COALESCE(media.items, '[]'::jsonb) AS media,
      updated_at.value AS "updatedAt"
    FROM hotel_catalog.properties property
    JOIN identity.organization_resource_links link
      ON link.organization_id = $1::uuid
     AND link.product = 'hotel_catalog'
     AND link.resource_type = 'property'
     AND link.resource_id = property.id::text
     AND link.relationship IN ('owner', 'operator')
     AND link.status = 'active'
    LEFT JOIN hotel_catalog.property_locations location
      ON location.property_id = property.id
    LEFT JOIN hotel_catalog.property_profiles profile
      ON profile.property_id = property.id
     AND profile.locale = property.default_locale
    LEFT JOIN LATERAL (
      SELECT
        max(value) FILTER (WHERE channel_type = 'website') AS website,
        COALESCE(
          max(value) FILTER (WHERE channel_type = 'phone'),
          max(value) FILTER (WHERE channel_type = 'whatsapp')
        ) AS phone,
        max(updated_at) AS updated_at
      FROM hotel_catalog.property_contact_channels
      WHERE property_id = property.id
        AND is_public = TRUE
        AND source_system = 'platform'
        AND channel_type IN ('website', 'phone', 'whatsapp')
    ) contact ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'mediaType', media.media_type,
            'url', media.url,
            'altText', media.alt_text,
            'sortOrder', media.sort_order
          )
          ORDER BY media.sort_order, media.created_at, media.id
        ) AS items,
        max(media.updated_at) AS updated_at
      FROM hotel_catalog.property_media media
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(value) AS value
      FROM (
        VALUES
          (property.updated_at),
          (location.updated_at),
          (profile.updated_at),
          (contact.updated_at),
          (media.updated_at)
      ) AS timestamps(value)
    ) updated_at ON TRUE
    WHERE property.id = $2::uuid
    LIMIT 1
  `;
}

function createPropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($2::jsonb) AS input(
        display_name text,
        country_code text,
        region text,
        city text,
        street_address text,
        postal_code text,
        raw_marketplace_location text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        map_display_mode text,
        short_description text,
        long_description text,
        website text,
        phone text,
        media jsonb
      )
    ),
    generated_property AS (
      SELECT gen_random_uuid() AS property_id
    ),
    created_property AS (
      INSERT INTO hotel_catalog.properties (
        id,
        public_id,
        display_name,
        profile_status,
        completeness_reasons
      )
      SELECT
        generated_property.property_id,
        'prop_' || replace(generated_property.property_id::text, '-', ''),
        profile_input.display_name,
        $3::text,
        $4::text[]
      FROM generated_property, profile_input
      RETURNING
        id AS property_id,
        public_id,
        default_locale,
        supported_locales,
        profile_status
    ),
    linked_property AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        'hotel_catalog',
        'property',
        created_property.property_id::text,
        'owner',
        'active'
      FROM created_property
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      RETURNING resource_id
    ),
    written_property AS (
      SELECT * FROM created_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function updatePropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($3::jsonb) AS input(
        display_name text,
        country_code text,
        region text,
        city text,
        street_address text,
        postal_code text,
        raw_marketplace_location text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        map_display_mode text,
        short_description text,
        long_description text,
        website text,
        phone text,
        media jsonb
      )
    ),
    target_property AS (
      SELECT property.id AS property_id
      FROM hotel_catalog.properties property
      JOIN identity.organization_resource_links link
        ON link.organization_id = $1::uuid
       AND link.product = 'hotel_catalog'
       AND link.resource_type = 'property'
       AND link.resource_id = property.id::text
       AND link.relationship IN ('owner', 'operator')
       AND link.status = 'active'
      WHERE property.id = $2::uuid
      LIMIT 1
    ),
    updated_property AS (
      UPDATE hotel_catalog.properties property
      SET display_name = profile_input.display_name,
          profile_status = CASE
            WHEN property.profile_status IN ('disabled', 'private') THEN property.profile_status
            ELSE $4::text
          END,
          completeness_reasons = $5::text[],
          updated_at = now()
      FROM target_property, profile_input
      WHERE property.id = target_property.property_id
      RETURNING
        property.id AS property_id,
        property.public_id,
        property.default_locale,
        property.supported_locales,
        property.profile_status
    ),
    written_property AS (
      SELECT * FROM updated_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function propertyProfileMutationCtes(): string {
  return `,
    upserted_location AS (
      INSERT INTO hotel_catalog.property_locations (
        property_id,
        country_code,
        region,
        city,
        street_address,
        postal_code,
        raw_marketplace_location,
        latitude,
        longitude,
        timezone,
        address_public,
        geo_public,
        map_display_mode,
        source_confidence,
        updated_at
      )
      SELECT
        written_property.property_id,
        NULLIF(profile_input.country_code, '')::char(2),
        profile_input.region,
        profile_input.city,
        profile_input.street_address,
        profile_input.postal_code,
        profile_input.raw_marketplace_location,
        profile_input.latitude,
        profile_input.longitude,
        profile_input.timezone,
        COALESCE(profile_input.address_public, TRUE),
        profile_input.latitude IS NOT NULL AND profile_input.longitude IS NOT NULL,
        COALESCE(profile_input.map_display_mode, 'hidden'),
        'verified',
        now()
      FROM written_property, profile_input
      ON CONFLICT (property_id) DO UPDATE
      SET country_code = EXCLUDED.country_code,
          region = EXCLUDED.region,
          city = EXCLUDED.city,
          street_address = EXCLUDED.street_address,
          postal_code = EXCLUDED.postal_code,
          raw_marketplace_location = EXCLUDED.raw_marketplace_location,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          timezone = EXCLUDED.timezone,
          address_public = EXCLUDED.address_public,
          geo_public = EXCLUDED.geo_public,
          map_display_mode = EXCLUDED.map_display_mode,
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      RETURNING property_id
    ),
    upserted_profile AS (
      INSERT INTO hotel_catalog.property_profiles (
        property_id,
        locale,
        short_description,
        long_description,
        source_confidence,
        updated_at
      )
      SELECT
        written_property.property_id,
        written_property.default_locale,
        profile_input.short_description,
        profile_input.long_description,
        'verified',
        now()
      FROM written_property, profile_input
      ON CONFLICT (property_id, locale) DO UPDATE
      SET short_description = EXCLUDED.short_description,
          long_description = EXCLUDED.long_description,
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      RETURNING property_id
    ),
    contact_input AS (
      SELECT written_property.property_id, 'website'::text AS channel_type, profile_input.website AS value
      FROM written_property, profile_input
      UNION ALL
      SELECT written_property.property_id, 'phone'::text AS channel_type, profile_input.phone AS value
      FROM written_property, profile_input
    ),
    deleted_contacts AS (
      DELETE FROM hotel_catalog.property_contact_channels contact
      USING written_property
      WHERE contact.property_id = written_property.property_id
        AND contact.channel_type IN ('website', 'phone')
        AND contact.source_system = 'platform'
        AND NOT EXISTS (
          SELECT 1
          FROM contact_input
          WHERE contact_input.channel_type = contact.channel_type
            AND contact_input.value IS NOT NULL
            AND contact_input.value = contact.value
        )
      RETURNING contact.property_id
    ),
    upserted_contacts AS (
      INSERT INTO hotel_catalog.property_contact_channels (
        property_id,
        channel_type,
        value,
        is_public,
        source_system,
        updated_at
      )
      SELECT
        contact_input.property_id,
        contact_input.channel_type,
        contact_input.value,
        TRUE,
        'platform',
        now()
      FROM contact_input
      WHERE contact_input.value IS NOT NULL
      ON CONFLICT (property_id, channel_type, value) DO UPDATE
      SET is_public = TRUE,
          source_system = EXCLUDED.source_system,
          updated_at = now()
      RETURNING property_id
    ),
    deleted_media AS (
      DELETE FROM hotel_catalog.property_media media
      USING written_property
      WHERE media.property_id = written_property.property_id
        AND media.source_system = 'platform'
      RETURNING media.property_id
    ),
    media_input AS (
      SELECT
        written_property.property_id,
        media.media_type,
        media.url,
        media.alt_text,
        media.sort_order
      FROM written_property, profile_input
      JOIN LATERAL jsonb_to_recordset(COALESCE(profile_input.media, '[]'::jsonb))
        AS media(media_type text, url text, alt_text text, sort_order int) ON TRUE
    ),
    inserted_media AS (
      INSERT INTO hotel_catalog.property_media (
        property_id,
        media_type,
        url,
        alt_text,
        sort_order,
        source_system,
        public_approved,
        updated_at
      )
      SELECT
        media_input.property_id,
        media_input.media_type,
        media_input.url,
        media_input.alt_text,
        media_input.sort_order,
        'platform',
        TRUE,
        now()
      FROM media_input
      RETURNING property_id
    )
  `;
}

function sharedHotelSetupStatusSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.public_id AS "publicId",
      property.display_name AS "displayName",
      property.profile_status AS "profileStatus",
      COALESCE(catalog_location.location, public_profile.location, '{}'::jsonb) AS "location",
      COALESCE(catalog_profile.descriptions, public_profile.descriptions, '{}'::jsonb) AS "descriptions",
      COALESCE(catalog_media.media, '[]'::jsonb) AS "media",
      COALESCE(catalog_contacts.public_contacts, '[]'::jsonb) AS "publicContacts",
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
    LEFT JOIN LATERAL (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'countryCode', location.country_code,
        'region', location.region,
        'city', location.city,
        'streetAddress', location.street_address,
        'postalCode', location.postal_code,
        'rawMarketplaceLocation', location.raw_marketplace_location,
        'timezone', location.timezone,
        'latitude', location.latitude,
        'longitude', location.longitude,
        'addressPublic', location.address_public,
        'mapDisplayMode', location.map_display_mode
      )) AS location
      FROM hotel_catalog.property_locations location
      WHERE location.property_id = property.id
    ) catalog_location ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'shortDescription', profile.short_description,
        'longDescription', profile.long_description
      )) AS descriptions
      FROM hotel_catalog.property_profiles profile
      WHERE profile.property_id = property.id
        AND profile.locale = property.default_locale
      LIMIT 1
    ) catalog_profile ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'type', media.media_type,
          'url', media.url,
          'altText', media.alt_text,
          'sortOrder', media.sort_order
        ))
        ORDER BY media.sort_order, media.created_at, media.id
      ) AS media
      FROM hotel_catalog.property_media media
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) catalog_media ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object('type', contact.channel_type, 'value', contact.value)
        ORDER BY contact.channel_type, contact.value
      ) AS public_contacts
      FROM hotel_catalog.property_contact_channels contact
      WHERE contact.property_id = property.id
        AND contact.is_public = TRUE
        AND contact.source_system = 'platform'
    ) catalog_contacts ON TRUE
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

function mediaItems(value: unknown): SharedPropertyProfileMedia[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): SharedPropertyProfileMedia | null => {
      const media = objectValue(item);
      const url = nonEmpty(media["url"]);
      if (!url) return null;
      const mediaTypeValue = nonEmpty(media["mediaType"] ?? media["media_type"]);
      const sortOrderValue = media["sortOrder"] ?? media["sort_order"];
      return {
        mediaType:
          mediaTypeValue === "hero_image" || mediaTypeValue === "logo"
            ? mediaTypeValue
            : "gallery_image",
        url,
        altText: nonEmpty(media["altText"] ?? media["alt_text"]),
        sortOrder:
          typeof sortOrderValue === "number"
            ? sortOrderValue
            : Number.parseInt(String(sortOrderValue), 10) || index,
      };
    })
    .filter((item): item is SharedPropertyProfileMedia => item !== null);
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

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapDisplayMode(value: string | null): SharedPropertyProfileLocation["mapDisplayMode"] {
  if (value === "approximate" || value === "exact") return value;
  return "hidden";
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
