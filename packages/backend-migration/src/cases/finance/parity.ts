import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type FinanceChecks = NonNullable<ExpectedTarget["financeChecks"]>;
type PropertyFlowCheck = NonNullable<FinanceChecks["propertyFlows"]>[number];
type AffiliatePayoutCheck = NonNullable<FinanceChecks["affiliatePayouts"]>[number];

async function checkPropertyFinanceFlow(
  client: pg.Client,
  flow: PropertyFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    provider_account_id: string;
    account_property_id: string;
    account_scope: string;
    provider: string;
    provider_account_ref: string;
    account_status: string;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    account_currency: string;
    sensitive_config_ref: string | null;
    settings_provider_account_id: string;
    payments_enabled: boolean;
    payment_id: string;
    payment_organization_id: string;
    guest_booking_id: string;
    source_payment_id: string;
    payment_status: string;
    payment_amount: string;
    net_payment_amount: string;
    payment_currency: string;
    payment_visibility_class: string;
    provider_payment_intent_id: string | null;
    payout_settings_id: string;
    payout_method: string;
    payout_status: string;
    sensitive_destination_ref: string | null;
    payout_id: string;
    payout_payment_id: string | null;
    payout_guest_booking_id: string | null;
    payout_provider_payout_id: string | null;
    payout_amount: string;
    payout_currency: string;
    commission_rule_id: string;
    commission_rule_scope: string;
    commission_product: string;
    commission_rate: string | null;
    commission_status: string;
    commission_rate_change_id: string;
    changed_by_user_id: string | null;
    new_percentage_rate: string | null;
    billing_entitlement_id: string;
    identity_entitlement_id: string | null;
    billing_status: string;
    plan_key: string | null;
    visibility_id: string;
    visibility_scope: string;
    visibility_property_id: string | null;
    visibility_resource_id: string;
    required_permission_key: string;
    gross_payment_amount: string;
    visibility_net_payment_amount: string;
    visibility_payout_amount: string;
    commission_amount: string;
    payment_count: number;
    payout_count: number;
  }>(
    `SELECT
       account.id::text AS provider_account_id,
       account.property_id::text AS account_property_id,
       account.account_scope,
       account.provider,
       account.provider_account_id AS provider_account_ref,
       account.status AS account_status,
       account.charges_enabled,
       account.payouts_enabled,
       account.default_currency AS account_currency,
       account.sensitive_config_ref,
       settings.provider_account_id::text AS settings_provider_account_id,
       settings.payments_enabled,
       payment.id::text AS payment_id,
       payment.organization_id::text AS payment_organization_id,
       payment.guest_booking_id::text AS guest_booking_id,
       payment.source_payment_id,
       payment.status AS payment_status,
       payment.amount::text AS payment_amount,
       payment.net_amount::text AS net_payment_amount,
       payment.currency AS payment_currency,
       payment.visibility_class AS payment_visibility_class,
       payment.provider_payment_intent_id,
       payout_settings.id::text AS payout_settings_id,
       payout_settings.payout_method,
       payout_settings.status AS payout_status,
       payout_settings.sensitive_destination_ref,
       payout.id::text AS payout_id,
       payout.payment_id::text AS payout_payment_id,
       payout.guest_booking_id::text AS payout_guest_booking_id,
       payout.provider_payout_id AS payout_provider_payout_id,
       payout.amount::text AS payout_amount,
       payout.currency AS payout_currency,
       commission_rule.id::text AS commission_rule_id,
       commission_rule.rule_scope AS commission_rule_scope,
       commission_rule.product AS commission_product,
       commission_rule.percentage_rate::text AS commission_rate,
       commission_rule.status AS commission_status,
       commission_change.id::text AS commission_rate_change_id,
       commission_change.changed_by_user_id::text AS changed_by_user_id,
       commission_change.new_percentage_rate::text AS new_percentage_rate,
       billing.id::text AS billing_entitlement_id,
       billing.identity_entitlement_id::text AS identity_entitlement_id,
       billing.billing_status,
       billing.plan_key,
       visibility.id::text AS visibility_id,
       visibility.visibility_scope,
       visibility.property_id::text AS visibility_property_id,
       visibility.resource_id AS visibility_resource_id,
       visibility.required_permission_key,
       visibility.gross_payment_amount::text AS gross_payment_amount,
       visibility.net_payment_amount::text AS visibility_net_payment_amount,
       visibility.payout_amount::text AS visibility_payout_amount,
       visibility.commission_amount::text AS commission_amount,
       visibility.payment_count,
       visibility.payout_count
     FROM finance.payment_provider_accounts account
     JOIN finance.payment_settings settings
       ON settings.property_id = account.property_id
      AND settings.provider_account_id = account.id
     JOIN finance.payments payment
       ON payment.provider_account_id = account.id
      AND payment.property_id = account.property_id
     JOIN finance.payout_settings payout_settings
       ON payout_settings.property_provider_account_id = account.id
      AND payout_settings.property_id = account.property_id
     JOIN finance.payouts payout
       ON payout.payout_setting_id = payout_settings.id
      AND payout.property_provider_account_id = account.id
      AND payout.property_id = account.property_id
      AND payout.payment_id = payment.id
      AND payout.guest_booking_id = payment.guest_booking_id
      AND payout.related_property_id = payment.property_id
     JOIN finance.commission_rules commission_rule
       ON commission_rule.id = $9
      AND commission_rule.property_id = account.property_id
     JOIN finance.commission_rate_changes commission_change
       ON commission_change.id = $10
      AND commission_change.commission_rule_id = commission_rule.id
     JOIN finance.billing_entitlements billing
       ON billing.id = $12
      AND billing.organization_id = payment.organization_id
      AND billing.property_id = account.property_id
     JOIN finance.finance_visibility_read_model visibility
       ON visibility.id = $13
      AND visibility.organization_id = payment.organization_id
      AND visibility.property_id = account.property_id
     WHERE account.id = $1
       AND account.property_id = $2
       AND payment.id = $3
       AND payment.organization_id = $4
       AND payment.guest_booking_id = $5
       AND payout_settings.id = $6
       AND payout.id = $7
       AND payout.provider_payout_id = $8
       AND billing.identity_entitlement_id = $11`,
    [
      flow.providerAccountId,
      flow.propertyId,
      flow.paymentId,
      flow.organizationId,
      flow.guestBookingId,
      flow.payoutSettingsId,
      flow.payoutId,
      flow.providerPayoutId,
      flow.commissionRuleId,
      flow.commissionRateChangeId,
      flow.identityEntitlementId,
      flow.billingEntitlementId,
      flow.visibilityReadModelId,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.provider_account_id === flow.providerAccountId &&
    row.account_property_id === flow.propertyId &&
    row.account_scope === "property" &&
    row.provider === "stripe" &&
    row.provider_account_ref === flow.providerAccountRef &&
    row.account_status === "active" &&
    row.charges_enabled === true &&
    row.payouts_enabled === true &&
    row.account_currency === flow.currency &&
    row.sensitive_config_ref !== null &&
    row.settings_provider_account_id === flow.providerAccountId &&
    row.payments_enabled === true &&
    row.payment_id === flow.paymentId &&
    row.payment_organization_id === flow.organizationId &&
    row.guest_booking_id === flow.guestBookingId &&
    row.source_payment_id === flow.sourcePaymentId &&
    row.payment_status === "paid" &&
    row.payment_amount === flow.paymentAmount &&
    row.net_payment_amount === flow.netPaymentAmount &&
    row.payment_currency === flow.currency &&
    row.payment_visibility_class === "pms_finance" &&
    row.provider_payment_intent_id === flow.providerPaymentIntentId &&
    row.payout_settings_id === flow.payoutSettingsId &&
    row.payout_method === "bank_account" &&
    row.payout_status === "active" &&
    row.sensitive_destination_ref !== null &&
    row.payout_id === flow.payoutId &&
    row.payout_payment_id === flow.paymentId &&
    row.payout_guest_booking_id === flow.guestBookingId &&
    row.payout_provider_payout_id === flow.providerPayoutId &&
    row.payout_amount === flow.payoutAmount &&
    row.payout_currency === flow.currency &&
    row.commission_rule_id === flow.commissionRuleId &&
    row.commission_rule_scope === "property" &&
    row.commission_product === "booking" &&
    row.commission_rate === flow.commissionRate &&
    row.commission_status === "active" &&
    row.commission_rate_change_id === flow.commissionRateChangeId &&
    row.changed_by_user_id === flow.ownerUserId &&
    row.new_percentage_rate === flow.commissionRate &&
    row.billing_entitlement_id === flow.billingEntitlementId &&
    row.identity_entitlement_id === flow.identityEntitlementId &&
    row.billing_status === "active" &&
    row.plan_key === "pms-pro" &&
    row.visibility_id === flow.visibilityReadModelId &&
    row.visibility_scope === flow.visibilityScope &&
    row.visibility_property_id === flow.propertyId &&
    row.visibility_resource_id === flow.propertyId &&
    row.required_permission_key === flow.requiredPermissionKey &&
    row.gross_payment_amount === flow.paymentAmount &&
    row.visibility_net_payment_amount === flow.netPaymentAmount &&
    row.visibility_payout_amount === flow.payoutAmount &&
    row.commission_amount === "150.00" &&
    row.payment_count === 1 &&
    row.payout_count === 1;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "FINANCE_PROPERTY_FLOW_MISMATCH",
      owner: "Finance",
      targetObject: "finance.payments",
      message: `Expected property finance flow ${flow.paymentId} was not found`,
      expected:
        "Property provider account, settings, payment, payout, commission, billing entitlement, and visibility rows linked to one property/org booking flow",
      actual: row ? JSON.stringify(row) : "row missing",
      suggestedAction:
        "Check finance fixture rows for stable IDs, property-scoped provider references, and payment/payout relationship integrity.",
    });
  }
}

async function checkPropertyOwnershipLinks(
  client: pg.Client,
  flow: PropertyFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_resource_links booking_link
       JOIN identity.organization_resource_links pms_link
         ON pms_link.organization_id = booking_link.organization_id
        AND pms_link.product = 'pms'
        AND pms_link.resource_type = 'pms_hotel'
        AND pms_link.resource_id = $3
        AND pms_link.relationship = 'operator'
        AND pms_link.status = 'active'
       JOIN identity.product_entitlements entitlement
         ON entitlement.id = $4
        AND entitlement.organization_id = booking_link.organization_id
        AND entitlement.product = 'pms'
        AND entitlement.entitlement_key = 'pms-core'
        AND entitlement.status = 'active'
        AND entitlement.resource_product = 'pms'
        AND entitlement.resource_type = 'pms_hotel'
        AND entitlement.resource_id = $3
       JOIN hotel_catalog.property_source_links booking_source
         ON booking_source.property_id = $5
        AND booking_source.source_system = 'booking'
        AND booking_source.source_table = 'booking_hotels'
        AND booking_source.source_id = $2
        AND booking_source.relationship = 'canonical_input'
       JOIN hotel_catalog.property_source_links pms_source
         ON pms_source.property_id = $5
        AND pms_source.source_system = 'pms'
        AND pms_source.source_table = 'hotels'
        AND pms_source.source_id = $3
        AND pms_source.relationship = 'operational_input'
       WHERE booking_link.organization_id = $1
         AND booking_link.product = 'booking'
         AND booking_link.resource_type = 'booking_hotel'
         AND booking_link.resource_id = $2
         AND booking_link.relationship = 'owner'
         AND booking_link.status = 'active'
     ) AS exists`,
    [
      flow.organizationId,
      flow.bookingHotelResourceId,
      flow.pmsHotelResourceId,
      flow.identityEntitlementId,
      flow.propertyId,
    ],
  );

  if (!result.rows[0].exists) {
    findings.push({
      severity: "fail",
      code: "FINANCE_PROPERTY_OWNERSHIP_LINK_MISMATCH",
      owner: "Finance",
      targetObject: "identity.organization_resource_links",
      message: `Expected finance property ${flow.propertyId} to be linked to organization ${flow.organizationId}`,
      expected:
        "Active booking owner link, active PMS operator link, active pms-core entitlement, and catalog source links for the same property",
      actual: "relationship not found",
      suggestedAction:
        "Check identity resource-link and property source-link fixtures before accepting finance rows for the property.",
    });
  }
}

async function checkAffiliatePayout(
  client: pg.Client,
  payout: AffiliatePayoutCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    provider_account_id: string;
    account_organization_id: string;
    account_scope: string;
    provider_account_ref: string;
    account_status: string;
    payouts_enabled: boolean;
    payout_settings_id: string;
    payout_settings_status: string;
    payout_id: string;
    payout_organization_id: string;
    payout_provider_payout_id: string | null;
    payout_amount: string;
    payout_currency: string;
    billing_entitlement_id: string;
    identity_entitlement_id: string | null;
    billing_status: string;
    visibility_id: string;
    visibility_scope: string;
    visibility_resource_type: string;
    visibility_resource_id: string;
    required_permission_key: string;
    visibility_payout_amount: string;
    visibility_payout_count: number;
    has_resource_link: boolean;
    has_entitlement: boolean;
  }>(
    `SELECT
       account.id::text AS provider_account_id,
       account.organization_id::text AS account_organization_id,
       account.account_scope,
       account.provider_account_id AS provider_account_ref,
       account.status AS account_status,
       account.payouts_enabled,
       payout_settings.id::text AS payout_settings_id,
       payout_settings.status AS payout_settings_status,
       payout.id::text AS payout_id,
       payout.organization_id::text AS payout_organization_id,
       payout.provider_payout_id AS payout_provider_payout_id,
       payout.amount::text AS payout_amount,
       payout.currency AS payout_currency,
       billing.id::text AS billing_entitlement_id,
       billing.identity_entitlement_id::text AS identity_entitlement_id,
       billing.billing_status,
       visibility.id::text AS visibility_id,
       visibility.visibility_scope,
       visibility.resource_type AS visibility_resource_type,
       visibility.resource_id AS visibility_resource_id,
       visibility.required_permission_key,
       visibility.payout_amount::text AS visibility_payout_amount,
       visibility.payout_count AS visibility_payout_count,
       EXISTS(
         SELECT 1
         FROM identity.organization_resource_links link
         WHERE link.organization_id = $1
           AND link.product = 'affiliate'
           AND link.resource_type = 'affiliate'
           AND link.resource_id = $2
           AND link.relationship = 'promotes'
           AND link.status = 'active'
       ) AS has_resource_link,
       EXISTS(
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.id = $6
           AND entitlement.organization_id = $1
           AND entitlement.product = 'affiliate'
           AND entitlement.entitlement_key = 'affiliate-payouts'
           AND entitlement.status = 'active'
       ) AS has_entitlement
     FROM finance.payment_provider_accounts account
     JOIN finance.payout_settings payout_settings
       ON payout_settings.organization_provider_account_id = account.id
      AND payout_settings.organization_id = account.organization_id
     JOIN finance.payouts payout
       ON payout.payout_setting_id = payout_settings.id
      AND payout.organization_provider_account_id = account.id
      AND payout.organization_id = account.organization_id
     JOIN finance.billing_entitlements billing
       ON billing.id = $7
      AND billing.organization_id = account.organization_id
     JOIN finance.finance_visibility_read_model visibility
       ON visibility.id = $8
      AND visibility.organization_id = account.organization_id
     WHERE account.organization_id = $1
       AND account.id = $3
       AND payout_settings.id = $4
       AND payout.id = $5
       AND billing.identity_entitlement_id = $6`,
    [
      payout.organizationId,
      payout.affiliateResourceId,
      payout.providerAccountId,
      payout.payoutSettingsId,
      payout.payoutId,
      payout.identityEntitlementId,
      payout.billingEntitlementId,
      payout.visibilityReadModelId,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.provider_account_id === payout.providerAccountId &&
    row.account_organization_id === payout.organizationId &&
    row.account_scope === "organization" &&
    row.provider_account_ref === payout.providerAccountRef &&
    row.account_status === "active" &&
    row.payouts_enabled === true &&
    row.payout_settings_id === payout.payoutSettingsId &&
    row.payout_settings_status === "active" &&
    row.payout_id === payout.payoutId &&
    row.payout_organization_id === payout.organizationId &&
    row.payout_provider_payout_id === payout.providerPayoutId &&
    row.payout_amount === payout.payoutAmount &&
    row.payout_currency === payout.currency &&
    row.billing_entitlement_id === payout.billingEntitlementId &&
    row.identity_entitlement_id === payout.identityEntitlementId &&
    row.billing_status === "active" &&
    row.visibility_id === payout.visibilityReadModelId &&
    row.visibility_scope === payout.visibilityScope &&
    row.visibility_resource_type === "affiliate" &&
    row.visibility_resource_id === payout.affiliateResourceId &&
    row.required_permission_key === payout.requiredPermissionKey &&
    row.visibility_payout_amount === payout.payoutAmount &&
    row.visibility_payout_count === 1 &&
    row.has_resource_link === true &&
    row.has_entitlement === true;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "FINANCE_AFFILIATE_PAYOUT_MISMATCH",
      owner: "Finance",
      targetObject: "finance.payouts",
      message: `Expected affiliate payout ${payout.payoutId} was not found`,
      expected:
        "Affiliate organization provider account, payout settings, payout, billing entitlement, resource link, and permissioned visibility row",
      actual: row ? JSON.stringify(row) : "row missing",
      suggestedAction:
        "Check affiliate payout ownership/resource-link rows and organization-scoped provider account relationships.",
    });
  }
}

async function checkVisibilityPrivateDataBoundary(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenKeys = expected.financeChecks?.forbiddenVisibilityKeys ?? [];
  if (forbiddenKeys.length === 0) return;

  const result = await client.query<{ id: string; summary: string }>(
    `SELECT id::text,
            concat_ws(
              ' ',
              resource_id,
              status_counts::text,
              entitlement_summary::text,
              source_freshness::text
            ) AS summary
     FROM finance.finance_visibility_read_model`,
  );

  for (const row of result.rows) {
    const matchedKey = forbiddenKeys.find((key) => row.summary.includes(key));
    if (!matchedKey) continue;

    findings.push({
      severity: "fail",
      code: "FINANCE_VISIBILITY_PRIVATE_KEY_LEAK",
      owner: "Finance",
      targetObject: "finance.finance_visibility_read_model",
      message: `Finance visibility row ${row.id} contains forbidden private key ${matchedKey}`,
      expected:
        "No provider account IDs, payment processor IDs, payout destination refs, sensitive config refs, or guest PII in finance visibility read models",
      actual: matchedKey,
      suggestedAction:
        "Keep provider/payment/payout private details in finance tables and project only permissioned aggregate summaries.",
    });
  }
}

async function checkFinanceFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.financeChecks;
  if (!checks) return;

  for (const flow of checks.propertyFlows ?? []) {
    await checkPropertyFinanceFlow(client, flow, findings);
    await checkPropertyOwnershipLinks(client, flow, findings);
  }

  for (const payout of checks.affiliatePayouts ?? []) {
    await checkAffiliatePayout(client, payout, findings);
  }

  await checkVisibilityPrivateDataBoundary(client, expected, findings);
}

export async function checkFinanceParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkFinanceFixtures(client, expected, findings);
}
