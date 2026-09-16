import { describe, expect, it } from "vitest";

import {
  buildFinanceExpenseCsvArtifact,
  FINANCE_EXPENSE_ORIGINS,
  normalizeFinanceExpenseAmount,
  parseFinanceExpenseExportQuery,
  parseFinanceExpenseExportSnapshot,
  parseFinanceExpenseQuery,
  parseFinanceExpenseWrite,
} from "./financialExpenses.js";

const COMMAND = {
  commandId: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "expense-command-1",
};
const CATEGORY_ID = "20000000-0000-4000-8000-000000000001";
const RECEIPT_ID = "30000000-0000-4000-8000-000000000001";

describe("Financials expense contract", () => {
  it("uses the accepted contract and complete origin vocabulary", () => {
    expect(FINANCE_EXPENSE_ORIGINS.join(",")).toBe(
      "manual,recurring,ota_commission,platform_fee,supplier_bill",
    );
  });

  it.each([
    ["999999999999999.9999", "999999999999999.9999"],
    ["0", null],
    ["1.00000", null],
    ["1000000000000000", null],
  ])("normalizes positive NUMERIC(19,4) amounts (%s)", (value, expected) => {
    expect(normalizeFinanceExpenseAmount(value)).toBe(expected);
  });

  it("parses normalized query defaults and documented filters", () => {
    expect(
      parseFinanceExpenseQuery({
        from: "2026-08-01",
        to: "2026-08-31",
        categoryId: CATEGORY_ID,
        paymentStatus: "unpaid",
        limit: "50",
        recurring: "true",
        origin: "recurring",
        search: "Electricity",
        sort: "amount_desc",
      }),
    ).toMatchObject({ limit: 50, sort: "amount_desc", origin: "recurring", recurring: true });
  });

  // prettier-ignore
  it("parses export filters without accepting pagination", () => {
    expect(parseFinanceExpenseExportQuery({ from: "2026-08-01", to: "2026-08-31", search: "Electricity", recurring: "false" })).toEqual({ from: "2026-08-01", to: "2026-08-31", search: "Electricity", recurring: false, sort: "incurredOn_desc" });
    expect(parseFinanceExpenseExportQuery({ from: "2026-08-01", to: "2026-08-31", limit: 50 })).toBeNull();
  });

  // prettier-ignore
  it("builds stable formula-safe expense CSV", () => {
    const artifact = buildFinanceExpenseCsvArtifact({ propertyId: COMMAND.commandId, currency: "EUR", expenses: [{ id: RECEIPT_ID, categoryId: CATEGORY_ID, categoryName: "=Utilities", origin: "manual", incurredOn: "2026-08-08", vendor: "+Vendor", amount: { amount: "12.5000" as never, currency: "EUR" }, paymentStatus: "unpaid", paidOn: null, recurringRuleId: null, sourceKey: "@source", reversesExpenseId: null, revision: 2 }] });
    expect(artifact).toMatchObject({ formatVersion: "pms-financials-expenses.v1", rowCount: 1, filename: `pms-financials-expenses-${COMMAND.commandId}.csv` });
    for (const value of ['"\'=Utilities"', '"\'+Vendor"', '"\'@source"']) expect(artifact.body).toContain(value);
    expect(() => buildFinanceExpenseCsvArtifact({ propertyId: "AAAAAAAA-0000-4000-8000-000000000001", currency: "EUR", expenses: [] })).toThrow();
  });

  // prettier-ignore
  it("validates immutable expense export snapshots", () => {
    const selected = { expenseId: RECEIPT_ID, revision: 2, categoryId: CATEGORY_ID, categoryRevision: 3, categoryName: "Utilities", paymentStatus: "unpaid", paidOn: null };
    const snapshot = { formatVersion: "pms-financials-expenses.v1", propertyId: COMMAND.commandId, currency: "EUR", filters: { from: "2026-08-01", to: "2026-08-31", sort: "incurredOn_desc" }, snapshotAt: "2026-08-31T10:00:00.000Z", manifest: [selected] };
    expect(parseFinanceExpenseExportSnapshot(snapshot)).toEqual(snapshot);
    expect(parseFinanceExpenseExportSnapshot({ ...snapshot, manifest: [selected, selected] })).toBeNull();
    expect(parseFinanceExpenseExportSnapshot({ ...snapshot, filters: { ...snapshot.filters, limit: 50 } })).toBeNull();
    expect(parseFinanceExpenseExportSnapshot({ ...snapshot, manifest: [{ ...selected, categoryName: " Utilities" }] })).toBeNull();
  });

  it.each([
    { from: "2026-08-31", to: "2026-08-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "0000-01-01", to: "2026-03-01" },
    { from: "2026-08-01", to: "2026-08-31", limit: 201 },
    { from: "2026-08-01", to: "2026-08-31", cursor: "A" },
    { from: "2026-08-01", to: "2026-08-31", cursor: "not a cursor!" },
    { from: "2026-08-01", to: "2026-08-31", recurring: "yes" },
    { from: "2026-08-01", to: "2026-08-31", surprise: true },
  ])("rejects an invalid or ambiguous query", (query) => {
    expect(parseFinanceExpenseQuery(query)).toBeNull();
  });

  it("parses paid recurring manual expense input without floats", () => {
    const parsed = parseFinanceExpenseWrite({
      ...COMMAND,
      incurredOn: "2026-08-08",
      vendor: "Utility Co",
      categoryId: CATEGORY_ID,
      amount: { amount: "125.5", currency: "EUR" },
      paymentStatus: "paid",
      paidOn: "2026-08-09",
      recurrence: { cadence: "monthly", startsOn: "2026-08-08" },
    });
    expect(parsed?.amount).toEqual({ amount: "125.5000", currency: "EUR" });
    expect(parsed?.recurrence?.cadence).toBe("monthly");
    // prettier-ignore
    expect(parseFinanceExpenseWrite({ ...COMMAND, incurredOn: "2026-08-08", vendor: "Utility Co", categoryId: CATEGORY_ID, amount: { amount: "1", currency: "EUR" }, paymentStatus: "unpaid", receiptMediaId: RECEIPT_ID })?.receiptMediaId).toBe(RECEIPT_ID);
    // prettier-ignore
    expect(parseFinanceExpenseWrite({ ...COMMAND, incurredOn: "2026-08-08", vendor: "Utility Co", categoryId: CATEGORY_ID, amount: { amount: "1", currency: "EUR" }, paymentStatus: "unpaid", paidOn: null })?.paidOn).toBeNull();
  });

  it.each([
    { amount: { amount: "0", currency: "EUR" }, paymentStatus: "unpaid" },
    { amount: { amount: "1", currency: "eur" }, paymentStatus: "unpaid" },
    { amount: { amount: "1", currency: "EUR" }, paymentStatus: "paid" },
    {
      amount: { amount: "1", currency: "EUR" },
      paymentStatus: "unpaid",
      receiptMediaId: "invalid",
    },
    {
      amount: { amount: "1", currency: "EUR" },
      paymentStatus: "unpaid",
      receiptMediaId: RECEIPT_ID,
      recurrence: { cadence: "monthly", startsOn: "2026-08-08" },
    },
  ])("rejects inconsistent expense money or payment state", (change) => {
    expect(
      parseFinanceExpenseWrite({
        ...COMMAND,
        incurredOn: "2026-08-08",
        vendor: "Vendor",
        categoryId: CATEGORY_ID,
        ...change,
      }),
    ).toBeNull();
  });
});
