import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();

vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

describe("financial report reads", () => {
  beforeEach(() => get.mockReset());

  it("uses the canonical Dashboard route with an optional property-local date", async () => {
    get.mockResolvedValue({});
    const { getFinanceDashboard } = await import("./financialReports");

    await getFinanceDashboard("property/id", { asOf: "2026-09-17" });

    expect(get).toHaveBeenCalledWith(
      "/finance/properties/property%2Fid/financials/dashboard?asOf=2026-09-17",
      { cache: "no-store", signal: undefined },
    );
  });
});
