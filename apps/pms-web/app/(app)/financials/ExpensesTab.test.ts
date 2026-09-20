import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFinanceExpenses = vi.fn();
const getExpenseCategories = vi.fn();
const requestExpenseCsv = vi.fn();
const getExpenseCsv = vi.fn();

vi.mock("@/services/finance/financialExpenses", () => ({
  getFinanceExpenses,
  getExpenseCategories,
  requestExpenseCsv,
  getExpenseCsv,
}));

const category = {
  id: "12140000-0000-4000-8000-000000000001",
  systemKey: null,
  name: "Housekeeping",
  color: "#1D4ED8",
  sortOrder: 1,
  archived: false,
  revision: 1,
};
const envelope = {
  contractVersion: "pms-financials.v1",
  propertyId: "12140000-0000-4000-8000-000000000002",
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-09-17T12:00:00.000Z",
  sourceFreshness: {},
  incompleteEvidence: [],
};
const money = (amount: string) => ({ amount, currency: "EUR" });
const metric = (amount: string) => ({
  value: money(amount),
  absoluteChange: money("0.0000"),
  percentChange: null,
});
const expenses = {
  ...envelope,
  summary: {
    totalMtd: metric("125.0000"),
    perOccupiedNight: metric("12.5000"),
    unpaidAmount: metric("25.0000"),
    unpaidCount: { value: 1, absoluteChange: 0, percentChange: null },
  },
  categories: [{ category, amount: money("125.0000") }],
  page: {
    items: [
      {
        id: "12140000-0000-4000-8000-000000000003",
        categoryId: category.id,
        origin: "recurring",
        incurredOn: "2026-09-15",
        vendor: "Weekly laundry",
        amount: money("25.0000"),
        paymentStatus: "unpaid",
        paidOn: null,
        recurringRuleId: "12140000-0000-4000-8000-000000000004",
        sourceKey: null,
        reversesExpenseId: null,
        revision: 1,
      },
      {
        id: "12140000-0000-4000-8000-000000000005",
        categoryId: category.id,
        origin: "ota_commission",
        incurredOn: "2026-09-14",
        vendor: "Booking.com",
        amount: money("100.0000"),
        paymentStatus: "paid",
        paidOn: "2026-09-14",
        recurringRuleId: null,
        sourceKey: "booking-1",
        reversesExpenseId: null,
        revision: 1,
      },
    ],
    nextCursor: null,
    limit: 50,
  },
};

describe("ExpensesTab", () => {
  beforeEach(() => {
    getFinanceExpenses.mockReset().mockResolvedValue(expenses);
    getExpenseCategories.mockReset().mockResolvedValue({ ...envelope, item: [category] });
    requestExpenseCsv.mockReset().mockResolvedValue({ item: { resourceId: "export-1" } });
    getExpenseCsv.mockReset().mockResolvedValue({
      contractVersion: "pms-financials-export.v1",
      propertyId: envelope.propertyId,
      item: {
        resourceId: "export-1",
        state: "ready",
        expiresAt: "2026-09-18T12:00:00.000Z",
        download: {
          method: "GET",
          url: "https://files.example/expenses.csv",
          expiresAt: "2026-09-17T12:15:00.000Z",
        },
      },
    });
  });

  async function render() {
    const { ExpensesTab } = await import("./ExpensesTab");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(ExpensesTab, {
          propertyId: envelope.propertyId,
          locale: "en-GB",
          generatedAt: envelope.generatedAt,
          timeZone: envelope.timeZone,
        }),
      );
    });
    return view;
  }

  it("distinguishes recurring and generated expenses in the ledger", async () => {
    const view = await render();
    const text = JSON.stringify(view.toJSON());

    expect(text).toContain("Recurring");
    expect(
      view.root
        .findAllByType("span")
        .some((span) => span.children.join("") === "ota commission · generated"),
    ).toBe(true);
    expect(text).toContain("Unpaid");
    expect(text).toContain("Paid");
  });

  it("keeps negative correction amounts visible in the category distribution", async () => {
    getFinanceExpenses.mockResolvedValue({
      ...expenses,
      categories: [{ category, amount: money("-25.0000") }],
    });
    const view = await render();
    const bar = view.root.findByProps({
      "aria-label": "Expense category amount distribution by magnitude",
    });

    expect(bar.findByType("span").props.style.width).toBe("100%");
    expect(JSON.stringify(view.toJSON())).toContain("-€25.00");
  });

  it("applies paid-state filters together before reloading and exporting", async () => {
    const view = await render();
    const paidState = view.root.findAllByType("select")[1]!;

    await act(async () => paidState.props.onChange({ target: { value: "unpaid" } }));
    expect(getFinanceExpenses).toHaveBeenCalledTimes(1);
    expect(
      view.root.findAllByType("button").find((button) => button.children.includes("Export CSV"))!
        .props.disabled,
    ).toBe(true);
    const form = view.root.findAllByType("form")[0]!;
    await act(async () => form.props.onSubmit({ preventDefault() {} }));

    expect(getFinanceExpenses).toHaveBeenLastCalledWith(
      envelope.propertyId,
      expect.objectContaining({ paymentStatus: "unpaid" }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    await act(async () =>
      view.root
        .findAllByType("button")
        .find((button) => button.children.includes("Export CSV"))!
        .props.onClick(),
    );
    expect(requestExpenseCsv).toHaveBeenCalledWith(
      envelope.propertyId,
      expect.objectContaining({ paymentStatus: "unpaid" }),
    );
  });

  it("exposes the signed download after the filtered export is ready", async () => {
    const view = await render();
    const exportButton = view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Export CSV"));

    await act(async () => exportButton!.props.onClick());

    expect(requestExpenseCsv).toHaveBeenCalledWith(
      envelope.propertyId,
      expect.objectContaining({ from: "2026-09-01", to: "2026-09-17" }),
    );
    expect(view.root.findByType("a").props.href).toBe("https://files.example/expenses.csv");
  });
});
