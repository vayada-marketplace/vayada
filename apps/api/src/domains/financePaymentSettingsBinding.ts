import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
  type FinancePricingCurrencyEvidence,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";

import {
  enqueueFinancePaymentReadinessChange,
  financePaymentSettingsAggregate,
  lockFinancePaymentSettings,
  type FinancePaymentSettingsLockedRow,
  type FinancePaymentSettingsQueryClient,
} from "./financePaymentReadinessCommandRepository.js";

// VAY-2136: the settings page (PATCH payment-settings) writes the same complete
// row as the setup Payments step: readiness contract, methods revision and the
// pricing currency revision it was saved against, plus the same change event.

const MAX_REVISION = 2_147_483_647;

export type FinancePaymentSettingsBinding = {
  paymentMethodsRevision: number;
  sourcePricingCurrencyRevision: number;
};

/**
 * The PMS pricing currency a settings-page save binds to. The row lock (what the
 * binding foreign key takes anyway) makes a PMS currency change, which locks this
 * row FOR UPDATE after the property, wait for the save. Lock the property first.
 */
export async function lockFinancePaymentPricingCurrency(
  client: FinancePaymentSettingsQueryClient,
  propertyId: string,
): Promise<FinancePricingCurrencyEvidence | null> {
  const result = await client.query<{ currency: unknown; revision: unknown }>(
    `SELECT currency::text AS currency, pricing_currency_revision AS revision
     FROM pms.property_pricing_settings
     WHERE property_id = $1::uuid
     FOR KEY SHARE`,
    [propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const revision = Number(row.revision);
  if (
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_REVISION
  ) {
    throw new Error("PMS pricing currency row failed contract validation");
  }
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    currency: row.currency,
    pricingCurrencyRevision: revision,
  };
}

/**
 * The binding a settings-page write stores, or null to keep the row's binding.
 * The revision moves when the row is unbound or its methods, enabled flag,
 * currency or pricing currency revision change; a save that only edits other
 * fields (such as the PayPal email) keeps it.
 */
export function nextFinancePaymentSettingsBinding(
  previous: FinancePaymentSettingsLockedRow | null,
  next: { acceptedMethods: readonly string[]; paymentsEnabled: boolean; defaultCurrency: string },
  pricing: FinancePricingCurrencyEvidence,
): FinancePaymentSettingsBinding | null {
  const revision =
    previous?.paymentMethodsRevision == null ? 0 : Number(previous.paymentMethodsRevision);
  if (
    revision > 0 &&
    Array.isArray(previous?.acceptedMethods) &&
    sameFinancePaymentMethods(previous.acceptedMethods, next.acceptedMethods) &&
    previous?.paymentsEnabled === next.paymentsEnabled &&
    previous.currency === next.defaultCurrency &&
    Number(previous.sourcePricingCurrencyRevision) === pricing.pricingCurrencyRevision
  ) {
    return null;
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= MAX_REVISION) {
    throw new Error("Finance payment-methods revision is exhausted or invalid");
  }
  return {
    paymentMethodsRevision: revision + 1,
    sourcePricingCurrencyRevision: pricing.pricingCurrencyRevision,
  };
}

/** The same method set, in any order. */
export function sameFinancePaymentMethods(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    right.every((method) => left.includes(method))
  );
}

/** Records the readiness change event the setup step records for its writes. */
export async function recordFinancePaymentSettingsBinding(
  client: FinancePaymentSettingsQueryClient,
  input: {
    previous: FinancePaymentSettingsLockedRow | null;
    propertyId: string;
    organizationId: string;
    actorUserId: string;
    correlationId: string;
    causationId: string;
    keyHash: string;
    pricing: FinancePricingCurrencyEvidence;
    at: Date;
  },
): Promise<void> {
  const { propertyId, pricing } = input;
  const before = financePaymentSettingsAggregate(input.previous, propertyId, pricing);
  const after = financePaymentSettingsAggregate(
    await lockFinancePaymentSettings(client, propertyId),
    propertyId,
    pricing,
  );
  await enqueueFinancePaymentReadinessChange(client, {
    eventKey: `finance.payment_readiness.changed.property.${propertyId}.settings.key.${input.keyHash}.v1`,
    outboxKey: `${FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION}.payment_methods.property.${propertyId}.settings.key.${input.keyHash}.v1`,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    keyHash: input.keyHash,
    at: input.at,
    event: {
      contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
      eventType: "finance.payment_readiness.changed",
      organizationId: input.organizationId,
      propertyId,
      paymentMethodsRevision: after.revision,
      sourcePricingCurrencyRevision: pricing.pricingCurrencyRevision,
      outcome:
        !before.bookingReady && after.bookingReady
          ? "readiness_gained"
          : before.bookingReady && !after.bookingReady
            ? "readiness_lost"
            : "selection_changed",
      sourceReadRequired: true,
    },
  });
}
