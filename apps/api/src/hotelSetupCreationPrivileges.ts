import { HOTEL_SETUP_FEATURE_HUB_PRIVILEGES } from "./hotelSetupFeatureHubPrivileges.js";
import {
  assertHotelSetupAuditBoundary,
  assertHotelSetupColumnPrivileges,
  type HotelSetupColumnPrivileges,
  type HotelSetupPrivilegeQueryable,
} from "./hotelSetupReaderPrivileges.js";

/** Creation only. Identity key UPDATE permits locks; native RLS denies actual changes. */
export const HOTEL_SETUP_CREATION_PRIVILEGES: HotelSetupColumnPrivileges = {
  ...Object.fromEntries(
    Object.entries(HOTEL_SETUP_FEATURE_HUB_PRIVILEGES).filter(
      ([relation]) =>
        relation.startsWith("identity.") &&
        !["identity.membership_property_assignments", "identity.product_entitlements"].includes(
          relation,
        ),
    ),
  ),
  "identity.organizations": { SELECT: ["id", "kind", "status"] },
  "identity.organization_resource_links": {
    SELECT: [
      "organization_id",
      "product",
      "resource_type",
      "resource_id",
      "relationship",
      "status",
    ],
    INSERT: [
      "organization_id",
      "product",
      "resource_type",
      "resource_id",
      "relationship",
      "status",
    ],
  },
  "identity.product_entitlements": {
    SELECT: [
      "organization_id",
      "product",
      "entitlement_key",
      "status",
      "resource_product",
      "resource_type",
      "resource_id",
      "starts_at",
      "expires_at",
    ],
  },
  "finance.billing_entitlements": {
    SELECT: [
      "organization_id",
      "product",
      "entitlement_key",
      "billing_status",
      "starts_at",
      "expires_at",
    ],
  },
  "hotel_catalog.hotel_setup_effective_creation_scopes": { SELECT: ["organization_id"] },
  "hotel_catalog.organization_setup_track_intents": {
    SELECT: ["organization_id", "selected_tracks"],
  },
  "hotel_catalog.properties": {
    SELECT: ["id", "display_name", "property_type", "profile_revision", "creation_organization_id"],
    INSERT: ["id", "public_id", "display_name", "property_type", "creation_organization_id"],
  },
  "hotel_catalog.property_locations": {
    SELECT: [
      "property_id",
      "country_code",
      "city",
      "street_address",
      "postal_code",
      "timezone",
      "latitude",
      "longitude",
      "address_public",
      "geo_public",
      "map_display_mode",
    ],
    INSERT: [
      "property_id",
      "country_code",
      "city",
      "street_address",
      "postal_code",
      "timezone",
      "latitude",
      "longitude",
      "address_public",
      "geo_public",
      "map_display_mode",
      "source_confidence",
      "updated_at",
    ],
  },
  "hotel_catalog.property_contact_channels": {
    SELECT: [
      "id",
      "property_id",
      "channel_type",
      "value",
      "purpose",
      "is_public",
      "source_system",
      "created_at",
    ],
    INSERT: [
      "property_id",
      "channel_type",
      "value",
      "purpose",
      "is_public",
      "source_system",
      "updated_at",
    ],
  },
  "hotel_catalog.property_owner_revisions": {
    SELECT: ["property_id", "owner_key", "revision"],
    INSERT: ["property_id", "owner_key", "revision"],
    UPDATE: ["revision"],
  },
  // PUBLIC pricing views are empty for organization logins: their assignment CHECK uses a disjoint prefix.
  "booking.pricing_runtime_effective_property_scopes": {
    SELECT: ["operation_class", "property_id", "organization_id"],
  },
  "booking.pricing_runtime_effective_authority_scopes": {
    SELECT: ["operation_class", "property_id", "revision"],
  },
  "booking.booking_settings": { SELECT: ["property_id"], INSERT: ["property_id"] },
  "marketplace.marketplace_hotel_profiles": {
    SELECT: ["property_id"],
    INSERT: ["property_id", "organization_id", "source_system", "source_hotel_profile_id"],
  },
  "platform.idempotency_keys": {
    SELECT: [
      "id",
      "status",
      "request_fingerprint_hash",
      "response_resource_id",
      "operation_scope",
      "operation",
      "key_hash",
      "tenant_scope",
      "organization_id",
      "correlation_id",
    ],
    INSERT: [
      "operation_scope",
      "operation",
      "key_hash",
      "request_fingerprint_hash",
      "tenant_scope",
      "organization_id",
      "correlation_id",
      "expires_at",
    ],
    UPDATE: [
      "status",
      "response_status_code",
      "response_resource_product",
      "response_resource_type",
      "response_resource_id",
      "completed_at",
      "last_seen_at",
    ],
  },
  "platform.product_audit_events": {
    INSERT: [
      "audit_key",
      "product",
      "action",
      "occurred_at",
      "tenant_scope",
      "organization_id",
      "actor_type",
      "actor_user_id",
      "target_resource_product",
      "target_resource_type",
      "target_resource_id",
      "idempotency_key_id",
      "correlation_id",
      "causation_id",
      "redacted_payload",
      "private_payload",
      "audit_metadata",
      "privacy_scope",
    ],
  },
};

const definers = [
  "platform.hotel_setup_property_read_allowed(uuid,uuid)",
  "platform.hotel_setup_property_id_unlinked(uuid)",
  "platform.hotel_setup_owner_link_insert_allowed(uuid,text)",
  "platform.hotel_setup_pending_financials_allowed(uuid,text)",
  "platform.hotel_setup_creation_assigned_organization()",
  "platform.hotel_setup_new_property_allowed(uuid)",
  "platform.hotel_setup_creation_product_link_allowed(uuid,text,text,text)",
  "platform.hotel_setup_creation_audit_key_allowed(uuid,uuid,text)",
];
const helpers = [...definers, "platform.hotel_setup_property_link_matches(uuid,text)"];

/** On the same begun native client, before replay, actor checks, or any writes. */
export async function assertHotelSetupCreationPrivileges(client: HotelSetupPrivilegeQueryable) {
  await assertHotelSetupColumnPrivileges(client, HOTEL_SETUP_CREATION_PRIVILEGES, definers);
  await assertHotelSetupAuditBoundary(client);
  const result = await client.query<{ safe: boolean }>(
    `SELECT (
    NOT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP')
    AND NOT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION')
    AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::regprocedure[])
      AND (NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
        OR p.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_creation_scopes'::regclass)
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]))
    AND (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($2::regprocedure[]) AND p.prosecdef)=8
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid),'' ORDER BY p.proname))
      FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::regprocedure[]))='0531e55e0593ef9121f291fa04037b55'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(
      c.oid::regclass::text || c.relrowsecurity::text || c.relforcerowsecurity::text || p.polname
      || p.polpermissive::text || p.polcmd::text
      || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN role=0 THEN 'PUBLIC' ELSE role::regrole::text END,
        ',' ORDER BY role::regrole::text) FROM pg_catalog.unnest(p.polroles) roles(role)),'')
      || COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'')
      || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),''),'' ORDER BY c.oid::regclass::text,p.polname))
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
      WHERE c.oid=ANY($3::regclass[]))='08c5e839b0e740f0c050887cccbfb7e1'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(c.oid::regclass::text
      || pg_catalog.pg_get_triggerdef(t.oid) || pg_catalog.pg_get_functiondef(t.tgfoid)
      || t.tgenabled::text,'' ORDER BY c.oid::regclass::text,t.tgname))
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND c.oid=ANY($3::regclass[]))='9ecef416addd500bd10cd69ea0b9df38'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($3::regclass[])
      AND (c.relowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_creation_scopes'::regclass)
        OR (c.relkind IN ('r','p') AND NOT c.relrowsecurity)))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgrelid=ANY($3::regclass[])
        AND p.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_creation_scopes'::regclass))
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(c.oid::regclass::text || pg_catalog.pg_get_viewdef(c.oid) || c.reloptions::text,'' ORDER BY c.oid::regclass::text))
      FROM pg_catalog.pg_class c WHERE c.oid=ANY(ARRAY['hotel_catalog.hotel_setup_effective_creation_scopes'::regclass,
        'booking.pricing_runtime_effective_property_scopes'::regclass,'booking.pricing_runtime_effective_authority_scopes'::regclass]))
      ='68e32b85eb5fb29a1de38bb86651705a'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_constraintdef(oid),'' ORDER BY conname))
      FROM pg_catalog.pg_constraint WHERE conrelid='platform.pricing_runtime_property_scopes'::regclass AND contype='c')='0f0734778b1ad4991cd754051721b818'
    AND NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET')
    AND pg_catalog.current_setting('session_replication_role')='origin'
  ) AS safe`,
    [helpers, definers, Object.keys(HOTEL_SETUP_CREATION_PRIVILEGES)],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup creation privilege posture mismatch");
}
