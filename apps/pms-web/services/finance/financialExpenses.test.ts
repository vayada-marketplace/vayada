import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get, post },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));

describe("financial expense operations", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    vi.stubGlobal("crypto", { randomUUID: () => "12140000-0000-4000-8000-000000000001" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves every ledger filter while reading expenses", async () => {
    get.mockResolvedValue({});
    const { getFinanceExpenses } = await import("./financialExpenses");

    await getFinanceExpenses("property/id", {
      from: "2026-09-01",
      to: "2026-09-17",
      categoryId: "category-1",
      paymentStatus: "unpaid",
      recurring: true,
      origin: "recurring",
      search: "Laundry",
      sort: "amount_desc",
    });

    expect(get).toHaveBeenCalledWith(
      "/finance/properties/property%2Fid/financials/expenses?from=2026-09-01&to=2026-09-17&sort=amount_desc&categoryId=category-1&paymentStatus=unpaid&recurring=true&origin=recurring&search=Laundry&limit=50",
      { cache: "no-store", signal: undefined },
    );
  });

  it("sends the same filters in an expense CSV snapshot request", async () => {
    post.mockResolvedValue({ item: { resourceId: "export-1", state: "pending" } });
    const { requestExpenseCsv } = await import("./financialExpenses");

    await requestExpenseCsv("property", {
      from: "2026-09-01",
      to: "2026-09-17",
      paymentStatus: "paid",
      recurring: false,
      origin: "supplier_bill",
      sort: "incurredOn_desc",
    });

    expect(post).toHaveBeenCalledWith(
      "/finance/properties/property/financials/exports",
      {
        commandId: "12140000-0000-4000-8000-000000000001",
        idempotencyKey: "12140000-0000-4000-8000-000000000001",
        tab: "expenses",
        format: "csv",
        filters: {
          from: "2026-09-01",
          to: "2026-09-17",
          paymentStatus: "paid",
          recurring: false,
          origin: "supplier_bill",
          sort: "incurredOn_desc",
        },
      },
      {
        cache: "no-store",
        headers: { "Idempotency-Key": "12140000-0000-4000-8000-000000000001" },
      },
    );
  });

  it("polls the scoped Financials export resource", async () => {
    get.mockResolvedValue({
      contractVersion: "pms-financials-export.v1",
      propertyId: "property",
      item: { resourceId: "export/id", state: "running", expiresAt: "2026-09-18T00:00:00Z" },
    });
    const { getExpenseCsv } = await import("./financialExpenses");

    await getExpenseCsv("property", "export/id");

    expect(get).toHaveBeenCalledWith(
      "/finance/properties/property/financials/exports/export%2Fid",
      { cache: "no-store" },
    );
  });
});
