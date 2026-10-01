import type pg from "pg";
import {
  assertHotelSetupNativePrivileges,
  HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
} from "./hotelSetupFeatureHubPrivileges.js";
import type { HotelSetupColumnPrivileges } from "./hotelSetupReaderPrivileges.js";

/** currency/currency_ready only. Identity key UPDATE grants take locks; RLS denies mutations. */
export const HOTEL_SETUP_CURRENCY_PRIVILEGES: HotelSetupColumnPrivileges = {
  ...Object.fromEntries(
    Object.entries(HOTEL_SETUP_FEATURE_HUB_PRIVILEGES).filter(([relation]) =>
      relation.startsWith("identity."),
    ),
  ),
  "identity.product_entitlements": {
    ...HOTEL_SETUP_FEATURE_HUB_PRIVILEGES["identity.product_entitlements"],
    SELECT: [
      ...HOTEL_SETUP_FEATURE_HUB_PRIVILEGES["identity.product_entitlements"]!.SELECT!.filter(
        (column) => column !== "updated_at",
      ),
      "id",
      "metadata",
    ],
  },
  "pms.property_pricing_settings": {
    SELECT: ["property_id", "currency", "pricing_currency_revision", "created_at", "updated_at"],
    INSERT: ["property_id", "currency", "pricing_currency_revision", "created_at", "updated_at"],
    UPDATE: ["currency", "pricing_currency_revision", "updated_at"],
  },
  "pms.room_types": { SELECT: ["property_id", "currency", "base_rate_amount", "active"] },
  "pms.rate_plans": { SELECT: ["property_id", "currency", "pricing_contract_version", "active"] },
  "pms.rate_rules": { SELECT: ["property_id"] },
  "pms.recurring_pricing_sources": { SELECT: ["property_id"] },
  "platform.idempotency_keys": {
    SELECT: [
      "id",
      "status",
      "request_fingerprint_hash",
      "response_status_code",
      "response_body_hash",
      "idempotency_metadata",
      "expires_at",
      "operation_scope",
      "operation",
      "key_hash",
      "tenant_scope",
      "organization_id",
      "property_id",
      "scope_key",
      "correlation_id",
      "first_seen_at",
      "last_seen_at",
    ],
    INSERT: [
      "operation_scope",
      "operation",
      "key_hash",
      "request_fingerprint_hash",
      "status",
      "tenant_scope",
      "organization_id",
      "property_id",
      "correlation_id",
      "first_seen_at",
      "last_seen_at",
      "expires_at",
      "idempotency_metadata",
    ],
    UPDATE: [
      "request_fingerprint_hash",
      "status",
      "response_status_code",
      "response_body_hash",
      "response_resource_product",
      "response_resource_type",
      "response_resource_id",
      "correlation_id",
      "first_seen_at",
      "last_seen_at",
      "completed_at",
      "expires_at",
      "idempotency_metadata",
    ],
  },
  "platform.domain_events": {
    SELECT: [
      "id",
      "property_id",
      "actor_user_id",
      "payload",
      "idempotency_key_hash",
      "source_system",
      "event_key",
    ],
    INSERT: [
      "source_system",
      "event_key",
      "event_type",
      "event_version",
      "occurred_at",
      "tenant_scope",
      "organization_id",
      "property_id",
      "resource_product",
      "resource_type",
      "resource_id",
      "actor_type",
      "actor_user_id",
      "correlation_id",
      "causation_id",
      "idempotency_key_hash",
      "payload",
      "event_metadata",
      "privacy_scope",
    ],
  },
  "platform.outbox_events": {
    SELECT: ["destination", "outbox_key"],
    INSERT: [
      "domain_event_id",
      "outbox_key",
      "destination",
      "event_type",
      "tenant_scope",
      "organization_id",
      "property_id",
      "resource_product",
      "resource_type",
      "resource_id",
      "correlation_id",
      "idempotency_key_hash",
      "payload",
      "outbox_metadata",
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
      "property_id",
      "actor_type",
      "actor_user_id",
      "target_resource_product",
      "target_resource_type",
      "target_resource_id",
      "domain_event_id",
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

/** Only first-save completion needs starter-category access. */
export const HOTEL_SETUP_CURRENCY_READY_PRIVILEGES: HotelSetupColumnPrivileges = {
  ...HOTEL_SETUP_CURRENCY_PRIVILEGES,
  "finance.expense_categories": {
    SELECT: ["property_id", "system_key", "archived_at"],
    INSERT: ["property_id", "system_key", "name", "color", "sort_order"],
  },
};

/** Call inside a successfully begun native currency scope. Not actor authorization or provisioning. */
export async function assertHotelSetupCurrencyPrivileges(
  client: Pick<pg.Pool, "query">,
  operation: "currency" | "currency_ready",
) {
  const inventory =
    operation === "currency_ready"
      ? HOTEL_SETUP_CURRENCY_READY_PRIVILEGES
      : HOTEL_SETUP_CURRENCY_PRIVILEGES;
  await assertHotelSetupNativePrivileges(
    client,
    inventory,
    operation === "currency_ready"
      ? "eed79e20681b7f2a84921e5826402051"
      : "caeb8242e09a8af001570421e558e76f",
  );
  const result = await client.query<{ safe: boolean }>(
    `SELECT (
    (SELECT pg_catalog.md5(pg_catalog.string_agg(c.oid::regclass::text
      || pg_catalog.pg_get_triggerdef(t.oid) || pg_catalog.pg_get_functiondef(t.tgfoid)
      || t.tgenabled::text,'' ORDER BY c.oid::regclass::text,t.tgname))
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND c.oid=ANY($1::regclass[]))=$2
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])
      AND c.relowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgrelid=ANY($1::regclass[])
        AND p.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass))
  ) AS safe`,
    [
      Object.keys(inventory),
      operation === "currency_ready"
        ? "cc0e1a70bfa0ef71d5834884f3faf541"
        : "bbbf7ac1eddd1ed6e6ce67556ff82d30",
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup currency trigger posture mismatch");
}
