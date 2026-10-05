import type pg from "pg";
import type { HotelSetupOperation } from "./hotelSetupCommandScope.js";
import {
  assertHotelSetupAuditBoundary,
  assertHotelSetupColumnPrivileges,
  type HotelSetupColumnPrivileges,
  type HotelSetupPrivilegeQueryable,
} from "./hotelSetupReaderPrivileges.js";

/** Native Feature Hub only. UPDATE of one key supplies row locks; RLS denies actual updates. */
export const HOTEL_SETUP_FEATURE_HUB_PRIVILEGES: HotelSetupColumnPrivileges = {
  "identity.users": { SELECT: ["id", "status"], UPDATE: ["id"] },
  "identity.organization_memberships": {
    SELECT: [
      "id",
      "organization_id",
      "user_id",
      "status",
      "role_key",
      "property_access_mode",
      "access_origin",
      "permission_overrides",
      "pms_access_enabled",
      "booking_access_enabled",
      "role_definition_id",
    ],
    UPDATE: ["id"],
  },
  "identity.membership_property_assignments": {
    SELECT: ["membership_id", "property_id"],
    UPDATE: ["membership_id"],
  },
  "identity.organization_roles": {
    SELECT: [
      "id",
      "organization_id",
      "security_class",
      "base_role_key",
      "preset_key",
      "default_permissions",
    ],
    UPDATE: ["id"],
  },
  "identity.role_permission_grants": {
    SELECT: ["organization_kind", "role_key", "permission_key"],
    UPDATE: ["role_key"],
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
      "updated_at",
    ],
    UPDATE: ["id"],
  },
  // Referenced by the shared audit RLS expression; Feature Hub purpose sees no currency evidence.
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
      "property_id",
      "actor_type",
      "actor_user_id",
      "target_resource_product",
      "target_resource_type",
      "target_resource_id",
      "correlation_id",
      "redacted_payload",
      "retention_class",
      "privacy_scope",
    ],
  },
};

const definers = [
  "platform.hotel_setup_property_allowed(uuid,uuid)",
  "platform.hotel_setup_property_operation_allowed(uuid,text)",
  "platform.hotel_setup_property_assigned_organization()",
];
const source = "platform.channex_management_worker_source(text,text,uuid)";
const scope = "platform.channex_management_worker_scope(text,text,uuid)";
export const HOTEL_SETUP_PROPERTY_RLS_HELPERS: Record<HotelSetupOperation, readonly string[]> = {
  launch_settings: [scope],
  currency_ready: [source, scope],
  feature_hub: [source, scope],
  currency: [],
};

/** Actual native commands need these invoker RLS helpers even for non-worker logins. */
export async function assertHotelSetupPropertyRlsHelpers(
  client: HotelSetupPrivilegeQueryable,
  operation: HotelSetupOperation,
) {
  const helpers = HOTEL_SETUP_PROPERTY_RLS_HELPERS[operation];
  if (!helpers.length) return;
  const result = await client.query<{ safe: boolean }>(
    `SELECT count(*) FILTER (WHERE NOT p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')
      AND p.proowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass)
      AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])=$2 AS safe
     FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::regprocedure[])`,
    [helpers, helpers.length],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup property RLS helper privileges unavailable");
}

/** Call inside a successfully begun native feature_hub scope. Not actor authorization. */
export async function assertHotelSetupFeatureHubPrivileges(client: Pick<pg.Pool, "query">) {
  await assertHotelSetupNativePrivileges(
    client,
    HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
    "16827da3dbb58d1daf6c2d1231323ad9",
  );
  await assertHotelSetupPropertyRlsHelpers(client, "feature_hub");
}

/** Shared native column, helper and policy attestation. Scope and actor checks remain separate. */
export async function assertHotelSetupNativePrivileges(
  client: HotelSetupPrivilegeQueryable,
  inventory: HotelSetupColumnPrivileges,
  policyDigest: string,
  allowedDeletes: readonly string[] = [],
) {
  await assertHotelSetupColumnPrivileges(client, inventory, definers, allowedDeletes);
  await assertHotelSetupAuditBoundary(client);
  const result = await client.query<{ safe: boolean }>(
    `SELECT (
    pg_catalog.has_function_privilege(current_user,'platform.tenant_scope_key(text,uuid,uuid)','EXECUTE')
    AND pg_catalog.has_function_privilege(current_user,'platform.valid_tenant_scope(text,uuid,uuid)','EXECUTE')
    AND (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::regprocedure[])
      AND p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
      AND p.proowner=(SELECT relowner FROM pg_catalog.pg_class
        WHERE oid='platform.hotel_setup_property_scopes'::regclass)
      AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])=3
    AND (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($2::regprocedure[])
      AND p.proname <> 'hotel_setup_property_link_matches'
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))=6
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid),'' ORDER BY p.proname))
      FROM pg_catalog.pg_proc p WHERE p.oid=ANY($2::regprocedure[]))='b59c9714d0f54b35a6858ab799f81878'
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(
      c.oid::regclass::text || c.relrowsecurity::text || c.relforcerowsecurity::text || p.polname
      || p.polpermissive::text || p.polcmd::text
      || COALESCE((SELECT pg_catalog.string_agg(
        CASE WHEN role=0 THEN 'PUBLIC' ELSE role::regrole::text END,',' ORDER BY role::regrole::text)
        FROM pg_catalog.unnest(p.polroles) roles(role)),'')
      || COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'')
      || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),''),'' ORDER BY c.oid::regclass::text,p.polname))
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
      WHERE c.oid=ANY($3::regclass[]))=$4
    AND NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET')
    AND pg_catalog.current_setting('session_replication_role')='origin'
  ) AS safe`,
    [
      definers,
      [
        ...definers,
        "platform.hotel_setup_property_row_allowed(uuid,uuid)",
        "platform.hotel_setup_property_owner_link_allowed(uuid,text,text,text)",
        "platform.hotel_setup_property_financials_read_allowed(uuid,text,text,text,text,text)",
        "platform.hotel_setup_property_link_matches(uuid,text)",
      ],
      Object.keys(inventory),
      policyDigest,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup native function posture mismatch");
}
