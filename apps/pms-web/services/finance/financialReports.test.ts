import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get, post },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

describe("financial report reads", () => {
  beforeEach(() => get.mockReset());

  it("uses the canonical Dashboard route with an optional property-local date", async () => {
    get.mockResolvedValue({});
    const { getFinanceDashboard } = await import("./financialReports");

    await getFinanceDashboard("property/id", { asOf: "2026-09-17" });

    expect(get).toHaveBeenCalledWith(
      "/api/finance/properties/property%2Fid/financials/dashboard?asOf=2026-09-17",
      { cache: "no-store", signal: undefined },
    );
  });

  it("uses the canonical Revenue route with its required range", async () => {
    get.mockResolvedValue({});
    const { getFinanceRevenue } = await import("./financialReports");

    await getFinanceRevenue("property", { from: "2026-09-01", to: "2026-09-17" });

    expect(get).toHaveBeenCalledWith(
      "/api/finance/properties/property/financials/revenue?from=2026-09-01&to=2026-09-17",
      { cache: "no-store", signal: undefined },
    );
  });

  it("uses the scoped Profit and Loss route for the selected year", async () => {
    get.mockResolvedValue({});
    const { getFinanceProfitLoss } = await import("./financialReports");

    await getFinanceProfitLoss("property/id", { year: 2026 });

    expect(get).toHaveBeenCalledWith(
      "/api/finance/properties/property%2Fid/financials/profit-loss?year=2026",
      { cache: "no-store", signal: undefined },
    );
  });

  it("looks up room type names without blocking Revenue reporting", async () => {
    get.mockResolvedValue({ items: [] });
    const { getRoomTypeNames } = await import("./financialReports");

    await getRoomTypeNames("property");

    expect(get).toHaveBeenCalledWith("/api/pms/properties/property/room-types", {
      cache: "no-store",
      signal: undefined,
    });
  });
});

describe("report CSV exports", () => {
  it("sends selected dates and a stable idempotency key to the property route", async () => {
    const { requestReportCsv, getReportCsv } = await import("./financialReports");
    const input = { tab: "revenue" as const, filters: { from: "2026-09-01", to: "2026-09-25" } };
    await requestReportCsv("property/id", input, "command-1");
    expect(post).toHaveBeenCalledWith(
      "/api/finance/properties/property%2Fid/financials/exports",
      { ...input, format: "csv", commandId: "command-1", idempotencyKey: "command-1" },
      { cache: "no-store", headers: { "Idempotency-Key": "command-1" }, signal: undefined },
    );
    await getReportCsv("property/id", "export/id");
    expect(get).toHaveBeenLastCalledWith(
      "/api/finance/properties/property%2Fid/financials/exports/export%2Fid",
      { cache: "no-store", signal: undefined },
    );
  });
});
