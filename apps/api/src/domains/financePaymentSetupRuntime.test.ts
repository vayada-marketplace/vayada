import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePmsPricingCurrency } from "@vayada/domain-pms";
import type { ReplaceFinancePaymentMethodsCommand } from "@vayada/domain-finance";
import { createFinancePaymentSetupRuntime } from "./financePaymentSetupRuntime.js";

const repository = vi.hoisted(() => ({ replacePaymentMethods: vi.fn(), close: vi.fn() }));
vi.mock("./financePaymentReadinessCommandRepository.js", () => ({
  createPgFinancePaymentReadinessCommandRepository: () => repository,
}));
const propertyId = "20000000-0000-4000-8000-000000000002";
const organizationId = "10000000-0000-4000-8000-000000000001";
const scope = { propertyId, organizationId };
const currency = {
  contractVersion: "pms-pricing.v1" as const,
  propertyId,
  currency: parsePmsPricingCurrency("EUR")!,
  pricingCurrencyRevision: 3,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};
afterEach(() => vi.clearAllMocks());

function harness() {
  const pricing = { getPropertyPricingCurrency: vi.fn().mockResolvedValue(currency) };
  const finance = { getPaymentReadiness: vi.fn().mockResolvedValue(null) };
  const ownerScope = { hasPaymentOwnerScope: vi.fn().mockResolvedValue(true) };
  const runtime = createFinancePaymentSetupRuntime({
    connectionString: "postgres://test",
    pricing,
    finance,
    scope: ownerScope,
  });
  return { runtime, pricing, finance, ownerScope };
}

describe("Finance payment setup runtime", () => {
  it("returns an unselected first-entry snapshot from scoped PMS currency without writing", async () => {
    const h = harness();
    expect(await h.runtime.routes.readPort.getPaymentReadiness(scope)).toMatchObject({
      propertyId,
      paymentMethodsRevision: 0,
      selectedMethodCount: 0,
      readyMethodCount: 0,
      paymentsEnabled: false,
      bookingPaymentReady: false,
      pricingCurrency: {
        committed: null,
        current: { currency: "EUR", pricingCurrencyRevision: 3 },
      },
    });
    expect(repository.replacePaymentMethods).not.toHaveBeenCalled();
  });
  it("does not turn unavailable scope or a failed read into an empty new configuration", async () => {
    const h = harness();
    h.ownerScope.hasPaymentOwnerScope.mockResolvedValue(false);
    expect(await h.runtime.routes.readPort.getPaymentReadiness(scope)).toBeNull();
    expect(h.pricing.getPropertyPricingCurrency).not.toHaveBeenCalled();
    h.ownerScope.hasPaymentOwnerScope.mockResolvedValue(true);
    h.finance.getPaymentReadiness.mockRejectedValue(new Error("read unavailable"));
    await expect(h.runtime.routes.readPort.getPaymentReadiness(scope)).rejects.toThrow(
      "read unavailable",
    );
  });
  it("returns saved readiness unchanged", async () => {
    const h = harness();
    const saved = { propertyId, paymentMethodsRevision: 8 };
    h.finance.getPaymentReadiness.mockResolvedValue(saved);
    expect(await h.runtime.routes.readPort.getPaymentReadiness(scope)).toBe(saved);
    expect(h.pricing.getPropertyPricingCurrency).not.toHaveBeenCalled();
  });
  it("delegates canonical selection to the transaction-owned command", async () => {
    const h = harness();
    repository.replacePaymentMethods.mockResolvedValue({
      ok: false,
      error: { code: "pricing_currency_unavailable" },
    });
    const command = { propertyId } as ReplaceFinancePaymentMethodsCommand;
    await h.runtime.routes.commandPort.replacePaymentMethods(command);
    expect(repository.replacePaymentMethods).toHaveBeenCalledWith({
      command,
      currentPricing: null,
    });
  });
});
