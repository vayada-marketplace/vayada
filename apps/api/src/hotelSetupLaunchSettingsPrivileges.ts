import type {
  HotelSetupColumnPrivileges,
  HotelSetupPrivilegeQueryable,
} from "./hotelSetupReaderPrivileges.js";
import {
  assertHotelSetupNativePrivileges,
  assertHotelSetupPropertyRlsHelpers,
  HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
} from "./hotelSetupFeatureHubPrivileges.js";

/** Column ACLs are part of this command's boundary: RLS restricts rows, not edited columns. */
export const HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES: HotelSetupColumnPrivileges = {
  ...Object.fromEntries(
    Object.entries(HOTEL_SETUP_FEATURE_HUB_PRIVILEGES).filter(
      ([relation]) =>
        relation.startsWith("identity.") && relation !== "identity.product_entitlements",
    ),
  ),
  "hotel_catalog.properties": { SELECT: ["id"], UPDATE: ["id"] },
  "booking.booking_settings": {
    SELECT: [
      "property_id",
      "default_currency",
      "supported_currencies",
      "default_language",
      "supported_languages",
    ],
    UPDATE: [
      "default_currency",
      "supported_currencies",
      "default_language",
      "supported_languages",
      "updated_at",
    ],
  },
  "hotel_catalog.property_contact_channels": {
    SELECT: ["id", "property_id", "channel_type", "value", "is_public", "source_system"],
    INSERT: ["property_id", "channel_type", "value", "is_public", "source_system"],
    UPDATE: ["is_public", "updated_at"],
  },
  "hotel_catalog.property_public_profile_read_model": {
    SELECT: ["property_id"],
    UPDATE: ["public_contacts", "projected_at"],
  },
  // Existing PUBLIC selector views become visible with booking schema USAGE;
  // this login has no pricing-runtime assignment and must see no selector rows.
  "booking.pricing_runtime_effective_property_scopes": {
    SELECT: ["property_id", "organization_id", "operation_class"],
  },
  "booking.pricing_runtime_effective_authority_scopes": {
    SELECT: ["property_id", "operation_class", "revision"],
  },
  // Referenced by the preserved audit RLS branches; this purpose sees no currency evidence.
  "platform.idempotency_keys": { SELECT: ["id", "property_id"] },
  "platform.domain_events": { SELECT: ["id", "property_id", "actor_user_id"] },
  "platform.product_audit_events": {
    SELECT: ["product", "audit_key"],
    INSERT: [
      "audit_key",
      "product",
      "action",
      "occurred_at",
      "tenant_scope",
      "organization_id",
      "property_id",
      "actor_type",
      "actor_user_id",
      "target_resource_product",
      "target_resource_type",
      "target_resource_id",
      "correlation_id",
      "redacted_payload",
      "audit_metadata",
      "retention_class",
      "privacy_scope",
    ],
  },
};

export async function assertHotelSetupLaunchSettingsPrivileges(
  client: HotelSetupPrivilegeQueryable,
) {
  await assertHotelSetupNativePrivileges(
    client,
    HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES,
    "6167ec974143c615fbc210fe7695539d",
    ["hotel_catalog.property_contact_channels"],
  );
  await assertHotelSetupPropertyRlsHelpers(client, "launch_settings");
  const triggers = await client.query<{ safe: boolean }>(
    `SELECT (
    SELECT pg_catalog.md5(pg_catalog.string_agg(c.oid::regclass::text
      || pg_catalog.pg_get_triggerdef(t.oid) || pg_catalog.pg_get_functiondef(t.tgfoid)
      || t.tgenabled::text,'' ORDER BY c.oid::regclass::text,t.tgname))
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal AND c.oid=ANY($1::regclass[])
  )='7ef659a4b0923028b59bae8581f57f6f'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(c.oid::regclass::text
      || pg_catalog.pg_get_viewdef(c.oid)||c.reloptions::text,'' ORDER BY c.oid::regclass::text))
      FROM pg_catalog.pg_class c WHERE c.oid=ANY(ARRAY[
        'booking.pricing_runtime_effective_property_scopes'::regclass,
        'booking.pricing_runtime_effective_authority_scopes'::regclass]))='8c37b2a713efa3ad7a47a792cd66e3d7'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_constraintdef(oid),'' ORDER BY conname))
      FROM pg_catalog.pg_constraint WHERE conrelid='platform.pricing_runtime_property_scopes'::regclass
        AND contype='c')='0f0734778b1ad4991cd754051721b818'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])
      AND (c.relowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass)
        OR (c.relkind IN ('r','p') AND NOT c.relrowsecurity))) AS safe`,
    [Object.keys(HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES)],
  );
  if (triggers.rows.length !== 1 || triggers.rows[0]?.safe !== true)
    throw new Error("Hotel setup launch settings trigger boundary mismatch");
}
