import { describe, expect, it, vi } from "vitest";
import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import { createFinancePaymentReadinessClient } from "./financePaymentReadinessClient";
const propertyId = "22222222-2222-4222-8222-222222222222";
const pricing = { contractVersion: "pms-pricing.v1", currency: "EUR", pricingCurrencyRevision: 3 };
const request = {
  expectedPaymentMethodsRevision: 0,
  expectedPricingCurrencyRevision: 3,
  selectedMethods: ["card"] as "card"[],
};
function harness() {
  const snapshot = createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 1,
    selectedMethods: ["card"],
    committedPricing: pricing,
    currentPricing: pricing,
    onlineCardReadiness: "execution_unavailable",
    updatedAt: "2026-09-11T00:00:00.000Z",
  });
  const http = {
    get: vi.fn().mockResolvedValue(snapshot),
    put: vi.fn().mockResolvedValue({
      contractVersion: "finance-payment-readiness.v1",
      outcome: "created",
      paymentReadiness: snapshot,
      acceptedAt: "2026-09-11T00:00:00.000Z",
    }),
  };
  return { snapshot, http, client: createFinancePaymentReadinessClient(http) };
}
describe("payment readiness browser client", () => {
  it("reads only provider identity without loading bank details or inferring readiness", async () => {
    const h = harness();
    h.http.get.mockResolvedValue({
      propertyId,
      contractVersion: "finance-route-contracts.v1",
      paymentSettings: { providerAccount: { providerAccountId: propertyId, provider: "stripe" } },
    });
    expect(await h.client.providerAccountId(propertyId)).toBe(propertyId);
    await expect(h.client.providerAccountId("other-property")).rejects.toThrow();
    expect(h.http.get).toHaveBeenCalledWith(
      `/api/finance/properties/${propertyId}/payment-settings`,
      undefined,
    );
    h.http.get.mockResolvedValue({
      propertyId,
      contractVersion: "finance-route-contracts.v1",
      paymentSettings: { providerAccount: { providerAccountId: propertyId, provider: "other" } },
    });
    await expect(h.client.providerAccountId(propertyId)).rejects.toThrow();
  });
  it("keeps selected but unready cards blocked", async () => {
    const h = harness();
    expect((await h.client.load(propertyId)).bookingPaymentReady).toBe(false);
    expect((await h.client.save(propertyId, request)).bookingPaymentReady).toBe(false);
  });
  it("reads unselected first entry without inventing ready methods", async () => {
    const h = harness();
    h.http.get.mockResolvedValue(
      createFinancePaymentReadinessSnapshot({
        propertyId,
        paymentMethodsRevision: 0,
        selectedMethods: [],
        committedPricing: null,
        currentPricing: pricing,
        onlineCardReadiness: "execution_unavailable",
        updatedAt: null,
      }),
    );
    expect(await h.client.load(propertyId)).toMatchObject({
      paymentMethodsRevision: 0,
      selectedMethodCount: 0,
      bookingPaymentReady: false,
    });
  });
  it("rejects readiness inconsistent with canonical evidence", async () => {
    const h = harness();
    h.http.get.mockResolvedValue({ ...h.snapshot, bookingPaymentReady: true });
    await expect(h.client.load(propertyId)).rejects.toThrow();
  });
  it("rejects cross-property and stale save receipts", async () => {
    const h = harness();
    await expect(h.client.load("other")).rejects.toThrow();
    await expect(h.client.save("other", request)).rejects.toThrow();
    await expect(
      h.client.save(propertyId, { ...request, expectedPaymentMethodsRevision: 2 }),
    ).rejects.toThrow();
  });
  it("rejects success receipts with changed or missing current currency", async () => {
    const h = harness();
    for (const currentPricing of [null, { ...pricing, pricingCurrencyRevision: 4 }]) {
      const snapshot = createFinancePaymentReadinessSnapshot({
        propertyId,
        paymentMethodsRevision: 1,
        selectedMethods: ["card"],
        committedPricing: pricing,
        currentPricing,
        onlineCardReadiness: "execution_unavailable",
        updatedAt: "2026-09-11T00:00:00.000Z",
      });
      h.http.put.mockResolvedValue({
        contractVersion: "finance-payment-readiness.v1",
        outcome: "created",
        paymentReadiness: snapshot,
        acceptedAt: "2026-09-11T00:00:00.000Z",
      });
      await expect(h.client.save(propertyId, request)).rejects.toThrow();
    }
  });
  it("retries an uncertain save with the same key", async () => {
    const h = harness();
    h.http.put.mockRejectedValueOnce(new Error("network"));
    await expect(h.client.save(propertyId, request)).rejects.toThrow("network");
    await h.client.save(propertyId, request);
    expect(h.http.put.mock.calls[0]).toEqual(h.http.put.mock.calls[1]);
  });
  it("never turns denied access into an empty configuration", async () => {
    const h = harness();
    h.http.get.mockRejectedValue(new Error("Forbidden"));
    await expect(h.client.load(propertyId)).rejects.toThrow("Forbidden");
  });
});
