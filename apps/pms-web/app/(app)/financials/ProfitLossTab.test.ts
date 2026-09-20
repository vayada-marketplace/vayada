import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFinanceProfitLoss = vi.fn();
const getExpenseCategories = vi.fn();
vi.mock("@/services/finance/financialReports", () => ({ getFinanceProfitLoss }));
vi.mock("@/services/finance/financialExpenses", () => ({ getExpenseCategories }));

const categoryId = "12140000-0000-4000-8000-0000000000aa";
const money = (amount: string) => ({ amount, currency: "EUR" });
const metric = (value: string) => ({
  value: money(value),
  absoluteChange: money("0.0000"),
  percentChange: null,
});
const categoryAmounts = () => ({
  ota_commission: money("0.0000"),
  staff: money("0.0000"),
  utilities: money("0.0000"),
  maintenance_supplies: money("0.0000"),
  marketing_platform: money("0.0000"),
  [`custom:${categoryId}`]: money("0.0000"),
});
const data = {
  contractVersion: "pms-financials.v1" as const,
  propertyId: "12140000-0000-4000-8000-000000000001",
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-09-17T12:00:00.000Z",
  sourceFreshness: {},
  incompleteEvidence: [],
  summary: {
    revenueYtd: metric("100.0000"),
    expensesYtd: metric("20.0000"),
    netProfitYtd: metric("80.0000"),
  },
  months: Array.from({ length: 9 }, (_, index) => ({
    month: `2026-${String(index + 1).padStart(2, "0")}`,
    roomRevenue: money(index === 0 ? "100.0000" : "0.0000"),
    upsellRevenue: money("0.0000"),
    revenue: money(index === 0 ? "100.0000" : "0.0000"),
    expenses: money(index === 0 ? "20.0000" : "0.0000"),
    netProfit: money(index === 0 ? "80.0000" : "0.0000"),
    expenseCategories: {
      ...categoryAmounts(),
      [`custom:${categoryId}`]: money(index === 0 ? "20.0000" : "0.0000"),
    },
  })),
};

describe("ProfitLossTab", () => {
  beforeEach(() => {
    getFinanceProfitLoss.mockReset().mockResolvedValue(data);
    getExpenseCategories
      .mockReset()
      .mockResolvedValue({ item: [{ id: categoryId, name: "Laundry" }] });
  });

  it("shows monthly custom category rows and refetches a selected year", async () => {
    const { ProfitLossTab } = await import("./ProfitLossTab");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(ProfitLossTab, {
          propertyId: data.propertyId,
          locale: "en-GB",
          generatedAt: data.generatedAt,
          timeZone: data.timeZone,
        }),
      );
    });
    expect(JSON.stringify(view.toJSON())).toContain("Laundry");
    expect(JSON.stringify(view.toJSON())).toContain("Net profit YTD");
    expect(view.root.findAllByType("tr")).toHaveLength(12);
    const input = view.root.findByType("input");
    await act(async () => input.props.onChange({ target: { value: "2025" } }));
    const exportButton = view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Export CSV"))!;
    expect(exportButton.props.disabled).toBe(true);
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(exportButton.props.disabled).toBe(false);
    expect(getFinanceProfitLoss).toHaveBeenLastCalledWith(
      data.propertyId,
      expect.objectContaining({ year: 2025 }),
    );
  });

  it("exports the selected year with currency and safe category labels without altering negative amounts", async () => {
    const { buildProfitLossCsv } = await import("./ProfitLossTab");
    const csv = buildProfitLossCsv(data, new Map([[categoryId, "=SUM(A1:A2)"]]));
    expect(csv).toContain('"2026-01 (EUR)"');
    expect(csv).toContain('"\'=SUM(A1:A2)"');
    expect(csv).toContain('"Net profit","80.0000"');
    expect(
      buildProfitLossCsv(
        { ...data, months: [{ ...data.months[0]!, netProfit: money("-20.0000") }] },
        new Map(),
      ),
    ).toContain('"Net profit","-20.0000"');
  });

  it("announces a failed report request and offers retry", async () => {
    getFinanceProfitLoss.mockRejectedValue(new Error("offline"));
    const { ProfitLossTab } = await import("./ProfitLossTab");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(ProfitLossTab, {
          propertyId: data.propertyId,
          locale: "en-GB",
          generatedAt: data.generatedAt,
          timeZone: data.timeZone,
        }),
      );
    });
    expect(view.root.findByProps({ role: "alert" })).toBeDefined();
    expect(JSON.stringify(view.toJSON())).toContain("could not be loaded");
    expect(
      view.root.findAllByType("button").some((button) => button.children.includes("Try again")),
    ).toBe(true);
  });
});
