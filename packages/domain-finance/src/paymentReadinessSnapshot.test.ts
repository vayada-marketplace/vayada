import { describe, expect, it } from "vitest";

import {
  createFinancePaymentReadinessSnapshot,
  resolveFinanceOnlineCardReadiness,
  type FinanceOnlineCardReadinessEvidence,
} from "./index.js";

const now = "2026-08-03T14:30:00.000Z";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const providerAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function onlineCardEvidence(
  overrides: Partial<FinanceOnlineCardReadinessEvidence> = {},
): FinanceOnlineCardReadinessEvidence {
  return {
    currencyEligible: true,
    propertyReadinessRevision: 8,
    providerAccount: {
      id: providerAccountId,
      provider: "stripe",
      accountScope: "property",
      providerBindingActive: true,
      status: "active",
      onboardingStatus: "completed",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      cardPaymentsStatus: "active",
      capabilities: ["card_payments"],
      cardCapabilityRevision: 4,
    },
    executionEvidence: null,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 3,
    selectedMethods: ["pay_at_property", "card"],
    committedPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 4,
    },
    currentPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 4,
    },
    onlineCardReadiness: "execution_unavailable",
    updatedAt: now,
    ...overrides,
  });
}

describe("Finance payment readiness derivation", () => {
  it("is ready with a verified Stripe account and no Vayada approval (VAY-2442)", () => {
    expect(resolveFinanceOnlineCardReadiness(onlineCardEvidence())).toBe("ready");
    // Without a payment account there is nothing to charge with.
    expect(resolveFinanceOnlineCardReadiness(onlineCardEvidence({ providerAccount: null }))).toBe(
      "execution_unavailable",
    );
  });

  it("ignores an approval from before VAY-2442, current or out of date", () => {
    const accepted = {
      contractVersion: "finance-online-card-execution-evidence.v1",
      providerAccountId,
      providerCapabilityRevision: 4,
      propertyReadinessRevision: 8,
      revokedAt: null,
    };
    for (const executionEvidence of [
      accepted,
      { ...accepted, providerCapabilityRevision: 3 },
      { ...accepted, propertyReadinessRevision: 7 },
      { ...accepted, providerAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ])
      expect(resolveFinanceOnlineCardReadiness(onlineCardEvidence({ executionEvidence }))).toBe(
        "ready",
      );
    // It is still checked for shape: the price fingerprint reads it.
    expect(() =>
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          executionEvidence: { ...accepted, providerAccountId: "not-a-uuid" },
        }),
      ),
    ).toThrow("execution evidence is invalid");
  });

  it("distinguishes provider restriction from canonical capability loss", () => {
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: { ...onlineCardEvidence().providerAccount!, status: "restricted" },
        }),
      ),
    ).toBe("provider_restricted");
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: {
            ...onlineCardEvidence().providerAccount!,
            cardPaymentsStatus: "inactive",
          },
        }),
      ),
    ).toBe("provider_capability_lost");
  });

  it("keeps unsupported settlement currencies closed in every Finance snapshot", () => {
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          currencyEligible: false,
          executionEvidence: {
            contractVersion: "finance-online-card-execution-evidence.v1",
            providerAccountId,
            providerCapabilityRevision: 4,
            propertyReadinessRevision: 8,
            revokedAt: null,
          },
        }),
      ),
    ).toBe("currency_unsupported");
    expect(
      snapshot({ selectedMethods: ["card"], onlineCardReadiness: "currency_unsupported" }).methods,
    ).toContainEqual(
      expect.objectContaining({
        method: "card",
        blockers: ["online_card_currency_unsupported"],
        nextActions: ["edit_pricing"],
      }),
    );
  });

  it("reads vayada Payment as ready with payouts on and its own binding, no approval (VAY-2442)", () => {
    const executionEvidence = {
      contractVersion: "finance-online-card-execution-evidence.v1",
      providerAccountId,
      providerCapabilityRevision: 4,
      propertyReadinessRevision: 8,
      revokedAt: null,
    };
    // Vayada's own Stripe account: no Stripe verification fields on the hotel's side.
    const vayada = {
      ...onlineCardEvidence().providerAccount!,
      provider: "vayada",
      detailsSubmitted: false,
      cardPaymentsStatus: null,
    };
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({ providerAccount: vayada, executionEvidence }),
      ),
    ).toBe("ready");
    expect(resolveFinanceOnlineCardReadiness(onlineCardEvidence({ providerAccount: vayada }))).toBe(
      "ready",
    );
    for (const lost of [
      { payoutsEnabled: false },
      { providerBindingActive: false },
      { chargesEnabled: false },
      { capabilities: [] },
      { provider: "xendit" },
      { provider: "paypal" },
    ])
      expect(
        resolveFinanceOnlineCardReadiness(
          onlineCardEvidence({ providerAccount: { ...vayada, ...lost }, executionEvidence }),
        ),
      ).toBe("provider_capability_lost");
    // Stripe still needs its own verification.
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: { ...onlineCardEvidence().providerAccount!, detailsSubmitted: false },
          executionEvidence,
        }),
      ),
    ).toBe("provider_capability_lost");
  });

  it("rejects non-property and placeholder provider bindings", () => {
    const executionEvidence = {
      contractVersion: "finance-online-card-execution-evidence.v1",
      providerAccountId,
      providerCapabilityRevision: 4,
      propertyReadinessRevision: 8,
      revokedAt: null,
    };
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: { ...onlineCardEvidence().providerAccount!, accountScope: "affiliate" },
          executionEvidence,
        }),
      ),
    ).toBe("provider_capability_lost");
    expect(
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: {
            ...onlineCardEvidence().providerAccount!,
            providerBindingActive: false,
          },
          executionEvidence,
        }),
      ),
    ).toBe("provider_capability_lost");
  });

  it("rejects structurally wider provider evidence instead of copying secrets", () => {
    expect(() =>
      resolveFinanceOnlineCardReadiness(
        onlineCardEvidence({
          providerAccount: {
            ...onlineCardEvidence().providerAccount!,
            providerSecret: "must-not-cross",
          } as never,
        }),
      ),
    ).toThrow("provider evidence is invalid");
  });

  it("makes committed Pay at hotel ready without bank data", () => {
    const result = snapshot({ selectedMethods: ["pay_at_property"] });
    expect(result).toMatchObject({
      bookingPaymentReady: true,
      selectedMethodCount: 1,
      readyMethodCount: 1,
      pricingCurrency: { matchesCurrent: true },
    });
    expect(result.methods).toEqual([
      expect.objectContaining({
        method: "pay_at_property",
        selected: true,
        readiness: "ready",
        blockers: [],
      }),
      expect.objectContaining({ method: "card", selected: false, readiness: "unready" }),
      expect.objectContaining({
        method: "bank_transfer",
        selected: false,
        availability: "unavailable",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/account|iban|swift|secret/i);
  });

  it("keeps a selected pending card as a warning when Pay at hotel is ready", () => {
    const result = snapshot();
    expect(result.bookingPaymentReady).toBe(true);
    expect(result.methods.find(({ method }) => method === "card")).toMatchObject({
      selected: true,
      availability: "available",
      readiness: "unready",
      consequence: "warning",
      blockers: ["online_card_execution_unavailable"],
    });
  });

  it("never makes a connected-card-shaped selection ready without execution evidence", () => {
    const result = snapshot({ selectedMethods: ["card"] });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "card")?.consequence).toBe("blocking");
  });

  it("makes card ready only after the canonical provider and execution decision is ready", () => {
    const result = snapshot({ selectedMethods: ["card"], onlineCardReadiness: "ready" });
    expect(result).toMatchObject({ bookingPaymentReady: true, readyMethodCount: 1 });
    expect(result.methods.find(({ method }) => method === "card")).toMatchObject({
      readiness: "ready",
      blockers: [],
    });
  });

  it.each([
    ["provider_restricted", "provider_restricted"],
    ["provider_capability_lost", "provider_capability_lost"],
    ["currency_unsupported", "online_card_currency_unsupported"],
    ["execution_unavailable", "online_card_execution_unavailable"],
  ] as const)("keeps card closed for %s", (onlineCardReadiness, blocker) => {
    const result = snapshot({ selectedMethods: ["card"], onlineCardReadiness });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "card")?.blockers).toContain(blocker);
  });

  it("keeps bank transfer unavailable and distinct from Pay at hotel", () => {
    const result = snapshot({ selectedMethods: ["bank_transfer"] });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "bank_transfer")).toMatchObject({
      availability: "unavailable",
      blockers: ["bank_transfer_contract_unavailable"],
    });
    expect(result.methods.find(({ method }) => method === "pay_at_property")?.selected).toBe(false);
  });

  it("fails selected payment methods closed when the pricing evidence moves", () => {
    const result = snapshot({
      currentPricing: {
        contractVersion: "pms-pricing.v1",
        currency: "CHF",
        pricingCurrencyRevision: 5,
      },
    });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "pay_at_property")).toMatchObject({
      readiness: "unready",
      blockers: ["pricing_currency_mismatch"],
    });
    expect(result.methods.find(({ method }) => method === "card")?.blockers).toEqual([
      "pricing_currency_mismatch",
      "online_card_execution_unavailable",
    ]);
  });

  it("fails Pay at hotel closed when the PMS contract binding moves", () => {
    const result = snapshot({
      currentPricing: {
        contractVersion: "pms-pricing.v2",
        currency: "EUR",
        pricingCurrencyRevision: 4,
      },
    });
    expect(result.methods.find(({ method }) => method === "pay_at_property")?.blockers).toEqual([
      "pricing_currency_mismatch",
    ]);
  });

  it("uses only the owner revision and returns detached frozen values", () => {
    const first = snapshot();
    const second = snapshot({ selectedMethods: ["card", "pay_at_property"] });
    expect(first.paymentMethodsRevision).toBe(second.paymentMethodsRevision);
    expect(first).not.toHaveProperty("readinessRevision");
    expect(Object.isFrozen(first.methods)).toBe(true);
    expect(Object.isFrozen(first.methods[0]?.blockers)).toBe(true);
  });

  it("does not copy structurally wider or secret-shaped pricing evidence", () => {
    expect(() =>
      snapshot({
        currentPricing: {
          contractVersion: "pms-pricing.v1",
          currency: "EUR",
          pricingCurrencyRevision: 4,
          providerSecret: "must-not-cross",
        },
      }),
    ).toThrow("Finance payment readiness input is invalid");
  });
});
