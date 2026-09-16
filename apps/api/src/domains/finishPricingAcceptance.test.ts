import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { finishPricingAcceptance } from "./finishPricingAcceptance.js";
import { finishCurrentQuoteAcceptanceTime } from "./currentQuoteAcceptanceTime.js";
vi.mock("./currentQuoteAcceptanceTime.js", () => ({ finishCurrentQuoteAcceptanceTime: vi.fn() }));
const scope = { propertyId: "hotel", organizationId: "org", authorityRevision: "revision" };
const client = {} as PoolClient;
const current = { scope } as Parameters<typeof finishPricingAcceptance>[2];
const finance = {
  scope,
  financeTermsCapturedAt: "2026-09-14T10:00:00.000Z",
  validUntil: "2026-09-14T10:05:00.000Z",
} as Parameters<typeof finishPricingAcceptance>[3];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(finishCurrentQuoteAcceptanceTime).mockResolvedValue("2026-09-14T10:04:59.999Z");
});
it("uses final quote-gate time and retains a still-valid Finance capture", async () => {
  expect(await finishPricingAcceptance(client, "hotel", current, finance)).toBe(
    "2026-09-14T10:04:59.999Z",
  );
  expect(finishCurrentQuoteAcceptanceTime).toHaveBeenCalledWith(client, "hotel", current);
});
it.each([
  "2026-09-14T10:05:00.000Z",
  "2026-09-14T10:06:00.000Z",
  "2026-09-14T09:59:59.999Z",
  "invalid",
])("rejects Finance expiry crossed during waits or invalid final time %s", async (checkedAt) => {
  vi.mocked(finishCurrentQuoteAcceptanceTime).mockResolvedValue(checkedAt);
  await expect(finishPricingAcceptance(client, "hotel", current, finance)).rejects.toThrow(
    "unavailable",
  );
});
it("allows explicitly unbounded Finance but still runs quote expiry checks", async () => {
  expect(
    await finishPricingAcceptance(client, "hotel", current, { ...finance, validUntil: null }),
  ).toBeTruthy();
  vi.mocked(finishCurrentQuoteAcceptanceTime).mockRejectedValue(new Error("quote expired"));
  await expect(
    finishPricingAcceptance(client, "hotel", current, { ...finance, validUntil: null }),
  ).rejects.toThrow("quote expired");
});
it.each([
  { scope: { ...scope, propertyId: "other" } },
  { scope: { ...scope, organizationId: "other" } },
  { scope: { ...scope, authorityRevision: "other" } },
  { financeTermsCapturedAt: "invalid" },
  { validUntil: "invalid" },
  { validUntil: finance.financeTermsCapturedAt },
])("rejects mismatched or malformed capture before checking quote time", async (patch) => {
  await expect(
    finishPricingAcceptance(client, "hotel", current, { ...finance, ...patch }),
  ).rejects.toThrow("unavailable");
  expect(finishCurrentQuoteAcceptanceTime).not.toHaveBeenCalled();
});
