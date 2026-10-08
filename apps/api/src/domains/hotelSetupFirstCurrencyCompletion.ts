import type { QueryResultRow } from "pg";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

/** Same list as platform.complete_hotel_setup_first_currency (migration 0448). */
export const FIRST_CURRENCIES = [
  "AED",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HRK",
  "INR",
  "LKR",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "RUB",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
];
export const BASE_ENTITLEMENTS = ["property-management", "pms-core", "account_access"];
const STARTER_CATEGORIES = [
  "staff",
  "ota_commission",
  "utilities",
  "maintenance",
  "supplies",
  "marketing",
  "platform_fees",
];

export class HotelSetupFirstCurrencyIncompleteError extends Error {
  readonly code = "23514";
}

/** Ordinary-login port of the deferred trigger platform.complete_hotel_setup_first_currency
 * (0448), which only fires for native logins (VAY-2056). Runs after the first currency (revision
 * 1, outcome created), its starter categories and its audit row, before COMMIT. Activates the
 * new-hotel default Financials entitlement and records pms.financials.default_activated.
 * A hotel without a pending default is untouched; a pending default whose prerequisites fail
 * aborts the whole currency command, exactly as the native trigger does. */
export async function completeOrdinaryHotelSetupFirstCurrency(
  client: Client,
  input: {
    propertyId: string;
    organizationId: string;
    currency: string;
    actorUserId: string;
    currencyAudit: { id: string | undefined; auditKey: string };
    domainEventId: string | null;
    idempotencyKeyId: string;
    correlationId: string;
    causationId: string;
  },
): Promise<void> {
  const pending = await client.query<{
    id: string;
    ready: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
  }>(
    `SELECT id::text, starts_at AS "startsAt", expires_at AS "expiresAt",
       status='suspended' AND metadata->>'newHotelFinancialsDefault'='pending' AS ready
     FROM identity.product_entitlements
     WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key='module:financials'
       AND resource_product='pms' AND resource_type='pms_property' AND lower(resource_id)=$2::uuid::text
     FOR UPDATE`,
    [input.organizationId, input.propertyId],
  );
  if (pending.rows.length !== 1 || !pending.rows[0]!.ready) return;
  if (!input.currencyAudit.id) throw new Error("First currency audit evidence missing");
  const entitlement = pending.rows[0]!;
  if (!FIRST_CURRENCIES.includes(input.currency))
    throw new HotelSetupFirstCurrencyIncompleteError("Hotel setup first currency invalid");

  await client.query(
    `SELECT id FROM identity.product_entitlements
     WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key = ANY(array_append($3::text[], 'module:financials'))
       AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
         AND lower(resource_id)=$2::uuid::text)) FOR SHARE`,
    [input.organizationId, input.propertyId, BASE_ENTITLEMENTS],
  );
  await client.query(
    `SELECT id FROM finance.expense_categories
     WHERE property_id=$1::uuid AND system_key = ANY($2::text[]) FOR SHARE`,
    [input.propertyId, STARTER_CATEGORIES],
  );
  const prerequisites = await client.query<{ ok: boolean }>(
    `WITH clock AS (SELECT clock_timestamp() AS at)
     SELECT ($4::timestamptz IS NULL OR $4::timestamptz <= clock.at)
       AND ($5::timestamptz IS NULL OR $5::timestamptz > clock.at)
       AND NOT EXISTS (SELECT 1 FROM identity.product_entitlements
         WHERE organization_id=$1::uuid AND product='pms' AND id<>$3::uuid
           AND entitlement_key = ANY(array_append($6::text[], 'module:financials')) AND status='suspended'
           AND (starts_at IS NULL OR starts_at<=clock.at) AND (expires_at IS NULL OR expires_at>clock.at)
           AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
             AND lower(resource_id)=$2::uuid::text)))
       AND EXISTS (SELECT 1 FROM identity.product_entitlements
         WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key = ANY($6::text[])
           AND status='active' AND (starts_at IS NULL OR starts_at<=clock.at)
           AND (expires_at IS NULL OR expires_at>clock.at)
           AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
             AND lower(resource_id)=$2::uuid::text)))
       AND (SELECT count(*) FROM finance.expense_categories WHERE property_id=$2::uuid
         AND archived_at IS NULL AND system_key = ANY($7::text[])) = 7 AS ok
     FROM clock`,
    [
      input.organizationId,
      input.propertyId,
      entitlement.id,
      entitlement.startsAt,
      entitlement.expiresAt,
      BASE_ENTITLEMENTS,
      STARTER_CATEGORIES,
    ],
  );
  if (prerequisites.rows[0]?.ok !== true)
    throw new HotelSetupFirstCurrencyIncompleteError(
      "Hotel setup Financials prerequisites incomplete",
    );

  await client.query(
    `UPDATE identity.product_entitlements SET status='active', updated_at=clock_timestamp(),
       metadata=metadata || jsonb_build_object('newHotelFinancialsDefault','ready',
         'newHotelFinancialsActivationTransaction', pg_current_xact_id()::text)
     WHERE id=$1::uuid`,
    [entitlement.id],
  );
  await client.query(
    `INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at, tenant_scope,
       property_id, actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata, privacy_scope)
     VALUES ($1 || '.financials-default', 'pms', 'pms.financials.default_activated', clock_timestamp(),
       'property', $2::uuid, 'user', $3::uuid, 'pms', 'pms_property', $2::uuid::text, $4::uuid,
       $5::uuid, $6, $7, jsonb_build_object('propertyId', $2::uuid::text, 'currency', $8::text),
       jsonb_build_object('sourceAuditId', $9::text, 'actorOrganizationId', $10::uuid::text),
       'confidential')`,
    [
      input.currencyAudit.auditKey,
      input.propertyId,
      input.actorUserId,
      input.domainEventId,
      input.idempotencyKeyId,
      input.correlationId,
      input.causationId,
      input.currency,
      input.currencyAudit.id,
      input.organizationId,
    ],
  );
}
