import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/** Proposal-independent Finance state inside a caller-authorized transaction.
 * Property/account UPDATE locks also block FK-backed settings/evidence insertion.
 * A source for missing or disabled settings is not payment readiness approval. */
export async function lockFinanceReplacementPricingSource(client: PoolClient, propertyId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) return null;
  propertyId = propertyId.toLowerCase();
  if (!(await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [propertyId])).rowCount) return null;
  const settings = (await client.query(`SELECT provider_account_id,
    (to_jsonb(s)-'created_at'-'updated_at')::text AS state FROM finance.payment_settings s WHERE property_id=$1 FOR SHARE`, [propertyId])).rows[0];
  let account: string | null = null;
  let evidence: unknown[] = [];
  if (settings?.provider_account_id) {
    // Only the payment-readiness inputs: Stripe account webhooks also record their event ID in
    // account_metadata and re-append capabilities, which must not stale published prices (VAY-2088).
    account = (await client.query(`SELECT jsonb_build_object('id',a.id,'provider',a.provider,'account_scope',a.account_scope,
      'provider_account_id',a.provider_account_id,'status',a.status,'onboarding_status',a.onboarding_status,
      'charges_enabled',a.charges_enabled,'payouts_enabled',a.payouts_enabled,'default_currency',a.default_currency,
      'capabilities',(SELECT jsonb_agg(DISTINCT capability ORDER BY capability) FROM unnest(a.capabilities) capability),
      'card_capability_revision',a.card_capability_revision,'details_submitted',a.account_metadata->'detailsSubmitted',
      'card_payments_status',a.account_metadata->'cardPaymentsStatus')::text AS state
      FROM finance.payment_provider_accounts a WHERE property_id=$1 AND id=$2 FOR UPDATE`, [propertyId, settings.provider_account_id])).rows[0]?.state ?? null;
    // JSONB text preserves exact values; epoch text is independent of session timezone.
    evidence = (await client.query(`SELECT (to_jsonb(e)-'created_at'-'updated_at'-'accepted_at'-'executed_at')::text AS state,
      extract(epoch FROM accepted_at)::text AS accepted_at,extract(epoch FROM executed_at)::text AS executed_at
      FROM finance.online_card_execution_evidence e WHERE property_id=$1 AND provider_account_id=$2 AND revoked_at IS NULL
      ORDER BY id FOR SHARE`, [propertyId, settings.provider_account_id])).rows;
  }
  return "finance.pricing.source.v2:" + createHash("sha256").update(JSON.stringify({ propertyId,
    settings: settings?.state ?? null, account, evidence })).digest("hex");
}
