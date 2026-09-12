import {
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import type { PmsPricingReadPort } from "@vayada/domain-pms";

import { createPgFinancePaymentReadinessCommandRepository } from "./financePaymentReadinessCommandRepository.js";
import type { PropertySetupFinanceOwnerScopePort } from "./propertySetupFinanceOwnerScope.js";

/** Reuses Finance commands and the PMS currency writer's exclusive lock. */
export function createFinancePaymentSetupRuntime(options: {
  connectionString: string;
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  finance: FinancePaymentReadinessReadPort;
  scope: PropertySetupFinanceOwnerScopePort;
}) {
  const repository = createPgFinancePaymentReadinessCommandRepository({
    connectionString: options.connectionString,
    max: 5,
    pricingReadPort: options.pricing,
  });
  const readPort: FinancePaymentReadinessReadPort = {
    async getPaymentReadiness(scope) {
      if (!(await options.scope.hasPaymentOwnerScope(scope))) return null;
      const saved = await options.finance.getPaymentReadiness(scope);
      if (saved) return saved;
      const current = await options.pricing.getPropertyPricingCurrency(scope.propertyId);
      if (current && current.propertyId !== scope.propertyId)
        throw new Error("Payment setup currency belongs to another property");
      // A scoped absence is a new configuration, not a committed/default method.
      return createFinancePaymentReadinessSnapshot({
        propertyId: scope.propertyId,
        paymentMethodsRevision: 0,
        selectedMethods: [],
        committedPricing: null,
        currentPricing: current
          ? {
              contractVersion: current.contractVersion,
              currency: current.currency,
              pricingCurrencyRevision: current.pricingCurrencyRevision,
            }
          : null,
        onlineCardReadiness: "execution_unavailable",
        updatedAt: null,
      });
    },
  };
  return {
    routes: {
      readPort,
      commandPort: {
        replacePaymentMethods: (
          command: import("@vayada/domain-finance").ReplaceFinancePaymentMethodsCommand,
        ) => repository.replacePaymentMethods({ command, currentPricing: null }),
      },
    },
    close: () => repository.close(),
  };
}
