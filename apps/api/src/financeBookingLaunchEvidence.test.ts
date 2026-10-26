import {
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import { isBookingLaunchOwnerEvidenceValid } from "@vayada/domain-booking";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import { createFinanceBookingLaunchEvidenceAdapter } from "./domains/financeBookingLaunchEvidence.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const request = { organizationId, propertyId };
const pricing = {
  contractVersion: PMS_PRICING_CONTRACT_VERSION,
  currency: "EUR",
  pricingCurrencyRevision: 7,
};

function snapshot(
  selectedMethods: Parameters<typeof createFinancePaymentReadinessSnapshot>[0]["selectedMethods"],
  overrides: Partial<Parameters<typeof createFinancePaymentReadinessSnapshot>[0]> = {},
) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 4,
    selectedMethods,
    committedPricing: pricing,
    currentPricing: pricing,
    onlineCardReadiness: "execution_unavailable",
    updatedAt: "2026-08-03T12:00:00.000Z",
    ...overrides,
  });
}

type BillingPlanPort = Parameters<
  typeof createFinanceBookingLaunchEvidenceAdapter
>[0]["billingPlan"];
/** A hotel with a usable billing plan; the config's contents don't matter to readiness. */
const planChosen: BillingPlanPort = { getBillingConfig: async () => ({}) as never };

function adapter(
  value: FinancePaymentReadinessSnapshot | null,
  options: {
    manualMethods?: readonly ("bank_transfer" | "paypal")[];
    inScope?: boolean;
    billingPlan?: BillingPlanPort;
  } = {},
) {
  const { manualMethods, inScope, billingPlan = planChosen } = options;
  const financeReadPort: FinancePaymentReadinessReadPort = {
    async getPaymentReadiness() {
      return value;
    },
  };
  return createFinanceBookingLaunchEvidenceAdapter({
    financeReadPort,
    billingPlan,
    ...(manualMethods ? { manualPayments: { readyMethods: async () => manualMethods } } : {}),
    ...(inScope === undefined ? {} : { scope: { hasPaymentReadinessScope: async () => inScope } }),
  });
}

describe("createFinanceBookingLaunchEvidenceAdapter", () => {
  it("asks for a billing plan until the hotel has one (VAY-2171)", async () => {
    const noPlan = { getBillingConfig: vi.fn(async () => null) };
    const codes = async (value: FinancePaymentReadinessSnapshot | null) => {
      const result = await adapter(value, { billingPlan: noPlan }).getBookingLaunchEvidence(
        request,
      );
      if (result.outcome !== "evidence") throw new Error(result.outcome);
      expect(isBookingLaunchOwnerEvidenceValid(result, request, "finance")).toBe(true);
      return result.entities[0]!.blockers.map(({ code, kind }) => `${code}:${kind}`);
    };
    // Ready payments, no plan: guests could not book, so the page can't publish.
    expect(await codes(snapshot(["pay_at_property"]))).toEqual([
      "billing_plan_not_selected:user_fixable",
    ]);
    // The hotel's own organization: a plan another organization chose doesn't let guests book.
    expect(noPlan.getBillingConfig).toHaveBeenCalledWith(propertyId, organizationId);
    // A brand-new hotel sees both to-dos in Payments.
    expect(await codes(null)).toEqual([
      "payment_methods_not_configured:user_fixable",
      "billing_plan_not_selected:user_fixable",
    ]);
    const failing = adapter(snapshot(["pay_at_property"]), {
      billingPlan: {
        getBillingConfig: async () => {
          throw new Error("connection refused");
        },
      },
    });
    await expect(failing.getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "system",
      code: "billing_plan_read_failed",
    });
  });

  it("counts a bank-transfer or PayPal hotel only while their acceptance is on (VAY-2139)", async () => {
    const blockers = async (manual?: readonly ("bank_transfer" | "paypal")[]) => {
      const result = await adapter(snapshot([]), {
        manualMethods: manual,
      }).getBookingLaunchEvidence(request);
      if (result.outcome !== "evidence") throw new Error(result.outcome);
      return result.entities[0]!.blockers.map(({ code }) => code);
    };
    expect(await blockers()).toEqual(["ready_payment_method_missing"]);
    expect(await blockers([])).toEqual(["ready_payment_method_missing"]);
    expect(await blockers(["bank_transfer"])).toEqual([]);
    expect(await blockers(["paypal"])).toEqual([]);
    const failing = createFinanceBookingLaunchEvidenceAdapter({
      financeReadPort: { getPaymentReadiness: async () => snapshot([]) },
      billingPlan: planChosen,
      manualPayments: {
        readyMethods: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    await expect(failing.getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "system",
      code: "payment_readiness_read_failed",
    });
  });

  it("emits one canonical Finance source with the accepted PMS currency binding", async () => {
    const result = await adapter(snapshot(["pay_at_property"])).getBookingLaunchEvidence(request);

    expect(result).toEqual({
      outcome: "evidence",
      port: "finance",
      organizationId,
      propertyId,
      sources: [
        {
          ownerDomain: "finance",
          entityType: "finance_payment_methods.v1",
          entityId: propertyId,
          revision: "4",
        },
      ],
      entities: [
        {
          groupId: "booking.payments",
          owningStepId: "payments",
          source: {
            ownerDomain: "finance",
            entityType: "finance_payment_methods.v1",
            entityId: propertyId,
            revision: "4",
          },
          blockers: [],
          bindings: [
            {
              expectedSource: {
                ownerDomain: "pms",
                entityType: "pms_property_pricing_currency.v1",
                entityId: propertyId,
                revision: "7",
              },
              mismatchBlocker: {
                code: "payment_currency_stale",
                scope: "launch_configuration",
                kind: "user_fixable",
              },
            },
          ],
        },
      ],
    });
    expect(isBookingLaunchOwnerEvidenceValid(result, request, "finance")).toBe(true);
  });

  it("keeps a selected card pending and an optional card warning non-blocking", async () => {
    const pending = await adapter(snapshot(["card"])).getBookingLaunchEvidence(request);
    const optional = await adapter(snapshot(["pay_at_property", "card"])).getBookingLaunchEvidence(
      request,
    );

    expect(pending).toMatchObject({
      entities: [
        {
          blockers: [
            {
              code: "online_card_execution_unavailable",
              kind: "external_pending",
            },
          ],
        },
      ],
    });
    expect(optional).toMatchObject({
      entities: [
        {
          blockers: [],
          advisories: [
            {
              code: "online_card_execution_unavailable",
              scope: "optional_external_pending",
            },
          ],
        },
      ],
    });
  });

  it("keeps a legacy-selected unavailable bank transfer blocking", async () => {
    const result = await adapter(
      snapshot(["pay_at_property", "bank_transfer"]),
    ).getBookingLaunchEvidence(request);

    expect(result).toMatchObject({
      entities: [
        {
          blockers: [
            {
              code: "bank_transfer_contract_unavailable",
              kind: "external_pending",
            },
          ],
        },
      ],
    });
    if (result.outcome === "evidence") expect(result.entities[0]).not.toHaveProperty("advisories");
  });

  it("lets the PMS source binding express a currency mismatch without a duplicate blocker", async () => {
    const result = await adapter(
      snapshot(["pay_at_property"], {
        currentPricing: { ...pricing, pricingCurrencyRevision: 8 },
      }),
    ).getBookingLaunchEvidence(request);

    expect(result).toMatchObject({
      entities: [
        {
          blockers: [],
          bindings: [
            {
              expectedSource: { revision: "7" },
              mismatchBlocker: { code: "payment_currency_stale" },
            },
          ],
        },
      ],
    });
  });

  it("asks the hotel to choose payment methods when none are versioned yet (VAY-2134)", async () => {
    const result = await adapter(null).getBookingLaunchEvidence(request);
    const source = {
      ownerDomain: "finance",
      entityType: "finance_payment_methods.v1",
      entityId: propertyId,
      revision: "absent",
    };

    expect(result).toEqual({
      outcome: "evidence",
      port: "finance",
      organizationId,
      propertyId,
      sources: [source],
      entities: [
        {
          groupId: "booking.payments",
          owningStepId: "payments",
          source,
          blockers: [
            {
              code: "payment_methods_not_configured",
              scope: "launch_configuration",
              kind: "user_fixable",
            },
          ],
        },
      ],
    });
    expect(isBookingLaunchOwnerEvidenceValid(result, request, "finance")).toBe(true);
    await expect(
      adapter(null, { inScope: true }).getBookingLaunchEvidence(request),
    ).resolves.toEqual(result);
  });

  it("keeps a property outside the Finance scope unavailable instead of asking for payments", async () => {
    await expect(
      adapter(null, { inScope: false }).getBookingLaunchEvidence(request),
    ).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "provider",
      code: "payment_scope_unavailable",
    });
    const failing = createFinanceBookingLaunchEvidenceAdapter({
      financeReadPort: { getPaymentReadiness: async () => null },
      billingPlan: planChosen,
      scope: {
        async hasPaymentReadinessScope() {
          throw new Error("connection refused");
        },
      },
    });
    await expect(failing.getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "system",
      code: "payment_scope_read_failed",
    });
  });

  it("returns explicit unavailable results for invalid or failed Finance reads", async () => {
    const poisoned = {
      ...snapshot(["pay_at_property"]),
      providerSecret: "must-not-cross-booking-boundary",
    } as unknown as FinancePaymentReadinessSnapshot;
    const invalid = await adapter(poisoned).getBookingLaunchEvidence(request);
    expect(invalid).toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "provider",
      code: "payment_readiness_invalid",
    });
    expect(JSON.stringify(invalid)).not.toContain("must-not-cross-booking-boundary");

    const failed = createFinanceBookingLaunchEvidenceAdapter({
      financeReadPort: {
        async getPaymentReadiness() {
          throw new Error("provider secret must stay private");
        },
      },
      billingPlan: planChosen,
    });
    await expect(failed.getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "system",
      code: "payment_readiness_read_failed",
    });
  });

  it("rejects mismatched Finance scope and non-PMS committed evidence", async () => {
    const wrongProperty = snapshot(["pay_at_property"], {
      propertyId: "323e4567-e89b-42d3-a456-426614174000",
    });
    const wrongContract = snapshot(["pay_at_property"], {
      committedPricing: { ...pricing, contractVersion: "lookalike-pricing.v1" },
    });

    await expect(adapter(wrongProperty).getBookingLaunchEvidence(request)).resolves.toMatchObject({
      outcome: "unavailable",
      errorSource: "provider",
    });
    await expect(adapter(wrongContract).getBookingLaunchEvidence(request)).resolves.toMatchObject({
      outcome: "unavailable",
      errorSource: "provider",
    });
  });
});
