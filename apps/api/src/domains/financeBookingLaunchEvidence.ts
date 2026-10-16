import {
  FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE,
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessBlocker,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  type BookingLaunchFinanceEvidencePort,
  type BookingLaunchOwnerAdvisory,
  type BookingLaunchOwnerBlocker,
  type BookingLaunchOwnerEvidence,
} from "@vayada/domain-booking";
import {
  PMS_PRICING_CONTRACT_VERSION,
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  serializePmsPricingSourceEntityRevision,
} from "@vayada/domain-pms";

import type { BillingPlanReadPort } from "./financeBillingConfigReadModel.js";
import type { FinanceManualPaymentReadinessReadPort } from "./financeManualPaymentReadiness.js";
import type { FinancePaymentReadinessScopePort } from "./financePaymentReadinessReadModel.js";

const EXTERNAL_PENDING = new Set<FinancePaymentReadinessBlocker>([
  "online_card_execution_unavailable",
  "provider_capability_lost",
  "bank_transfer_contract_unavailable",
]);

export function createFinanceBookingLaunchEvidenceAdapter(dependencies: {
  financeReadPort: FinancePaymentReadinessReadPort;
  /** Finance's billing config is null until the hotel has a usable plan: the acceptance rule. */
  billingPlan: BillingPlanReadPort;
  /** Bank transfer and PayPal, only while their acceptance is on (VAY-2139). */
  manualPayments?: FinanceManualPaymentReadinessReadPort;
  scope?: FinancePaymentReadinessScopePort;
}): BookingLaunchFinanceEvidencePort {
  return {
    bookingLaunchEvidencePort: "finance",
    async getBookingLaunchEvidence(request) {
      let value: unknown;
      try {
        value = await dependencies.financeReadPort.getPaymentReadiness(request);
      } catch {
        return unavailable("system", "payment_readiness_read_failed");
      }
      // Bookings are refused without a chosen plan, so publishing waits for one (VAY-2171).
      let planBlockers: BookingLaunchOwnerBlocker[];
      try {
        planBlockers = (await dependencies.billingPlan.getBillingConfig(
          request.propertyId,
          request.organizationId,
        ))
          ? []
          : [ownerBlocker("billing_plan_not_selected", "user_fixable")];
      } catch {
        return unavailable("system", "billing_plan_read_failed");
      }
      // No versioned payment methods yet: never chosen, or saved only by the older settings
      // page. The setup Payments step creates them (VAY-2134). A missing organization, PMS
      // link or entitlement also reads as nothing, and no payment choice fixes that.
      if (value === null) {
        let inScope: boolean;
        try {
          inScope = (await dependencies.scope?.hasPaymentReadinessScope(request)) ?? true;
        } catch {
          return unavailable("system", "payment_scope_read_failed");
        }
        return inScope
          ? notConfigured(request, planBlockers)
          : unavailable("provider", "payment_scope_unavailable");
      }
      const snapshot = parseFinancePaymentReadinessSnapshot(value);
      if (!snapshot || snapshot.propertyId !== request.propertyId) {
        return unavailable("provider", "payment_readiness_invalid");
      }

      try {
        const financeSource = createFinancePaymentMethodsSourceEntityRevision(
          snapshot.propertyId,
          snapshot.paymentMethodsRevision,
        );
        const pricingSource = snapshot.pricingCurrency.committed
          ? pricingBindingSource(snapshot.propertyId, snapshot.pricingCurrency.committed)
          : null;
        if (snapshot.pricingCurrency.committed && !pricingSource) {
          return unavailable("provider", "payment_pricing_contract_unsupported");
        }

        const blockingCodes = snapshot.methods
          .filter(
            ({ method, consequence }) =>
              consequence === "blocking" || (consequence === "warning" && method !== "card"),
          )
          .flatMap(({ blockers }) => blockers);
        const blockers = ownerBlockers(blockingCodes, Boolean(pricingSource));
        if (!snapshot.bookingPaymentReady && blockers.length === 0 && blockingCodes.length === 0) {
          // A bank-transfer or PayPal hotel is ready when the hotel can be paid that way.
          let manual: readonly string[];
          try {
            manual = dependencies.manualPayments
              ? await dependencies.manualPayments.readyMethods({ propertyId: request.propertyId })
              : [];
          } catch {
            return unavailable("system", "payment_readiness_read_failed");
          }
          if (manual.length === 0)
            blockers.push(ownerBlocker("ready_payment_method_missing", "user_fixable"));
        }
        blockers.push(...planBlockers);
        const advisories = ownerAdvisories(
          snapshot.methods
            .filter(({ method, consequence }) => method === "card" && consequence === "warning")
            .flatMap(({ blockers }) => blockers),
        );
        const evidence = {
          outcome: "evidence",
          port: "finance",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sources: [financeSource],
          entities: [
            {
              groupId: "booking.payments",
              owningStepId: "payments",
              source: financeSource,
              blockers,
              ...(advisories.length > 0 ? { advisories } : {}),
              ...(pricingSource
                ? {
                    bindings: [
                      {
                        expectedSource: pricingSource,
                        mismatchBlocker: ownerBlocker("payment_currency_stale", "user_fixable"),
                      },
                    ],
                  }
                : {}),
            },
          ],
        } as const satisfies BookingLaunchOwnerEvidence<"finance">;
        return evidence;
      } catch {
        return unavailable("provider", "payment_readiness_invalid");
      }
    },
  };
}

function notConfigured(
  request: { organizationId: string; propertyId: string },
  planBlockers: readonly BookingLaunchOwnerBlocker[],
) {
  const source = {
    ownerDomain: "finance",
    entityType: FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE,
    entityId: request.propertyId,
    revision: "absent",
  } as const;
  return {
    outcome: "evidence",
    port: "finance",
    organizationId: request.organizationId,
    propertyId: request.propertyId,
    sources: [source],
    entities: [
      {
        groupId: "booking.payments",
        owningStepId: "payments",
        source,
        blockers: [ownerBlocker("payment_methods_not_configured", "user_fixable"), ...planBlockers],
      },
    ],
  } as const satisfies BookingLaunchOwnerEvidence<"finance">;
}

function pricingBindingSource(
  propertyId: string,
  evidence: { contractVersion: string; pricingCurrencyRevision: number },
) {
  return evidence.contractVersion === PMS_PRICING_CONTRACT_VERSION
    ? serializePmsPricingSourceEntityRevision(
        PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
        propertyId,
        evidence.pricingCurrencyRevision,
      )
    : null;
}

function ownerBlockers(
  codes: readonly FinancePaymentReadinessBlocker[],
  hasPricingBinding: boolean,
): BookingLaunchOwnerBlocker[] {
  return [...new Set(codes)]
    .filter((code) => code !== "pricing_currency_mismatch" || !hasPricingBinding)
    .map((code) =>
      ownerBlocker(code, EXTERNAL_PENDING.has(code) ? "external_pending" : "user_fixable"),
    );
}

function ownerAdvisories(
  codes: readonly FinancePaymentReadinessBlocker[],
): BookingLaunchOwnerAdvisory[] {
  return [...new Set(codes)].map((code) => ({
    code,
    scope: "optional_external_pending",
  }));
}

function ownerBlocker(
  code: string,
  kind: "user_fixable" | "external_pending",
): BookingLaunchOwnerBlocker {
  return { code, scope: "launch_configuration", kind };
}

function unavailable(errorSource: "provider" | "system", code: string) {
  return { outcome: "unavailable", port: "finance", errorSource, code } as const;
}
