import { describe, expect, it } from "vitest";

import { financeDashboardPeriods } from "@vayada/domain-finance";

import {
  composeFinanceDashboardResponse,
  type FinanceDashboardResponseInput,
} from "./financeDashboardResponse.js";

const PROPERTY = "11280000-0000-4000-8000-000000000001";
const ROOM = "11280000-0000-4000-8000-000000000010";

describe("Finance Dashboard response", () => {
  it("composes gross revenue, expenses, profit, daily activity, and upcoming projections", () => {
    const result = composeFinanceDashboardResponse(input());
    expect(result).toMatchObject({
      contractVersion: "pms-financials.v1",
      propertyId: PROPERTY,
      currency: "EUR",
      timeZone: "Europe/Berlin",
      generatedAt: "2026-08-03T14:00:00.000Z",
      sourceFreshness: {
        pmsPricing: "2026-08-03T09:00:00Z",
        bookingRevenueThrough: "2026-08-03",
        bookingAddonRevenueAt: "2026-08-03T12:00:00.000Z",
        financeExpensesAt: "2026-08-03T13:00:00.000Z",
      },
      cards: {
        revenueToday: metric("110.0000", "65.0000", "1.4444"),
        revenueMtd: metric("310.0000", "210.0000", "2.1000"),
        expensesMtd: metric("30.0000", "20.0000", "2.0000"),
        profitMtd: metric("280.0000", "190.0000", "2.1111"),
      },
    });
    expect(result.daily.find(({ date }) => date === "2026-07-27")).toEqual({
      date: "2026-07-27",
      revenue: money("45.0000"),
      expenses: money("0.0000"),
    });
    expect(result.daily.at(-1)).toEqual({
      date: "2026-08-03",
      revenue: money("110.0000"),
      expenses: money("20.0000"),
    });
    expect(result.upcoming).toEqual([
      {
        date: "2026-08-04",
        kind: "recurring_expense",
        amount: money("30.0000"),
        predicted: true,
      },
    ]);
    expect(result.incompleteEvidence).toEqual([
      { code: "room_revenue_currency_mismatch", count: 1, currency: "USD" },
      { code: "addon_fulfillment_missing", count: 2 },
      {
        code: "expense_currency_mismatch",
        count: 1,
        amount: { amount: "9.0000", currency: "USD" },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/guest|vendor|category|provider|secret/i);
  });

  it("returns a zero state and rejects incomplete daily expense evidence", () => {
    const value = input();
    value.rooms.rows = [];
    value.addOns.rows = [];
    value.expenses.totals = { current: "0", comparison: "0" };
    value.expenses.daily = value.expenses.daily.map(({ date }) => ({ date, amount: "0" }));
    expect(composeFinanceDashboardResponse(value).cards.profitMtd).toEqual(
      metric("0.0000", "0.0000", null),
    );
    value.expenses.daily.pop();
    expect(() => composeFinanceDashboardResponse(value)).toThrow(
      "Finance Dashboard daily expense facts are incomplete",
    );
  });

  it.each([
    ["reversed", { from: "2026-08-03", to: "2026-07-21" }],
    ["thirteen days", { from: "2026-07-22", to: "2026-08-03" }],
    ["huge", { from: "1000-01-01", to: "2026-08-03" }],
  ])("rejects a %s daily range before iterating it", (_name, daily) => {
    const value = input();
    value.periods.daily = daily;
    expect(() => composeFinanceDashboardResponse(value)).toThrow(
      "Finance Dashboard response periods are invalid",
    );
  });

  it("rejects noncanonical comparison periods", () => {
    const value = input();
    value.periods.today.comparison = { from: "2026-07-26", to: "2026-07-26" };
    expect(() => composeFinanceDashboardResponse(value)).toThrow(
      "Finance Dashboard response periods are invalid",
    );
  });
});

function input(): FinanceDashboardResponseInput {
  const periods = financeDashboardPeriods("2026-08-03");
  return {
    propertyId: PROPERTY,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: "2026-08-03T14:00:00Z",
    sourceFreshness: { pmsPricing: "2026-08-03T09:00:00Z" },
    periods,
    rooms: {
      rows: [
        room("current", "2026-07-27", "40"),
        room("current", "2026-08-01", "200"),
        room("current", "2026-08-03", "100"),
        room("comparison", "2026-07-03", "80"),
      ],
      eligibleBookings: { current: 0, comparison: 0 },
      sourceFreshness: {
        bookingRevenueThrough: "2026-08-03",
        financeOtaCommissionAt: null,
      },
      incompleteEvidence: [{ code: "room_revenue_currency_mismatch", count: 1, currency: "USD" }],
    },
    addOns: {
      rows: [
        addOn("current", "2026-07-27", "5"),
        addOn("current", "2026-08-03", "10"),
        addOn("comparison", "2026-07-03", "20"),
      ],
      fulfilledBookings: { current: 0, comparison: 0 },
      sourceFreshness: {
        bookingAddonRevenueThrough: null,
        bookingAddonRevenueAt: "2026-08-03T12:00:00.000Z",
      },
      incompleteEvidence: [{ code: "addon_fulfillment_missing", count: 2 }],
    },
    expenses: {
      totals: { current: "30", comparison: "10" },
      daily: days(periods.daily.from, periods.daily.to).map((date) => ({
        date,
        amount: date === "2026-08-03" ? "20" : "0",
      })),
      upcoming: [{ date: "2026-08-04", kind: "recurring_expense", amount: "30", predicted: true }],
      sourceFreshness: {
        financeExpensesAt: "2026-08-03T13:00:00.000Z",
        financeRecurringExpensesAt: null,
      },
      incompleteEvidence: [
        {
          code: "expense_currency_mismatch",
          count: 1,
          amount: { amount: "9.0000", currency: "USD" },
        },
      ],
    },
  };
}

// prettier-ignore
const room = (period: "current" | "comparison", recognizedOn: string, grossRoomAmount: string) => ({ period, recognizedOn, channel: "direct", directSource: null, roomTypeId: ROOM, grossRoomAmount, otaCommissionAmount: "0", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 });
// prettier-ignore
const addOn = (period: "current" | "comparison", recognizedOn: string, revenueAmount: string) => ({ period, recognizedOn, ownership: "property" as const, revenueAmount });
const money = (amount: string) => ({ amount, currency: "EUR" });
// prettier-ignore
const metric = (value: string, absoluteChange: string, percentChange: string | null) => ({ value: money(value), absoluteChange: money(absoluteChange), percentChange });
function days(from: string, to: string): string[] {
  const values = [];
  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  )
    values.push(new Date(day).toISOString().slice(0, 10));
  return values;
}
