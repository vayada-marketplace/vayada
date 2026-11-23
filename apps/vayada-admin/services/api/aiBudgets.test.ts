import { describe, expect, it } from "vitest";
import {
  budgetField,
  budgetInput,
  budgetUse,
  changedOn,
  formatUsd,
  monthLabel,
  monthStartLabel,
  nextMonthLabel,
  noAiUse,
  problemOf,
  stoppedNote,
  type AiAccountBudget,
} from "./aiBudgets";

const account = (overrides: Partial<AiAccountBudget> = {}): AiAccountBudget => ({
  organizationId: "6f1c2a4e-0000-4000-8000-000000000001",
  name: "Harbour House Lisbon",
  status: "active",
  monthlyLimitMicroUsd: 25_000_000,
  custom: true,
  usedMicroUsd: 6_410_000,
  calls: 3077,
  updatedAt: "2026-11-12T09:30:00.000Z",
  ...overrides,
});

describe("AI budgets for vayada staff (VAY-2504)", () => {
  it("shows micro-dollars as dollars and cents, and a tiny spend as under a cent", () => {
    expect(formatUsd(6_410_000)).toBe("$6.41");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(100_000_000_000)).toBe("$100,000.00");
    expect(formatUsd(4_999)).toBe("under $0.01");
    expect(formatUsd(5_000)).toBe("$0.01");
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  it("takes dollars as the server does: up to $100,000, whole cents", () => {
    expect(budgetInput("40")).toBe("40");
    expect(budgetInput(" 12.50 ")).toBe("12.50");
    expect(budgetInput("$25")).toBe("25");
    expect(budgetInput("1,000.5")).toBe("1000.5");
    expect(budgetInput("0")).toBe("0");
    expect(budgetInput("100000")).toBe("100000");
    for (const bad of ["", "abc", "-5", "12.505", "100000.01", "1000000", "1,00", "1e3", ".5"])
      expect(budgetInput(bad), bad).toBeNull();
  });

  it("starts the dialog with the account's own budget, empty on the default", () => {
    expect(budgetField(account())).toBe("25.00");
    expect(budgetField(account({ monthlyLimitMicroUsd: 12_500_000 }))).toBe("12.50");
    expect(budgetField(account({ custom: false, monthlyLimitMicroUsd: 0 }))).toBe("");
  });

  it("pauses AI once the budget is used up, and says a $0 budget keeps it off", () => {
    expect(budgetUse(account())).toEqual({ share: 0.2564, usedUp: false, off: false });
    expect(stoppedNote(account(), "2026-11-01")).toBeNull();
    const usedUp = account({ usedMicroUsd: 25_000_000 });
    expect(budgetUse(usedUp)).toEqual({ share: 1, usedUp: true, off: false });
    expect(stoppedNote(usedUp, "2026-11-01")).toBe("Used up · AI paused until December 1");
    // Staff set $0 after some spend: AI stays off, also after the 1st.
    const off = account({ monthlyLimitMicroUsd: 0 });
    expect(budgetUse(off)).toEqual({ share: 1, usedUp: false, off: true });
    expect(stoppedNote(off, "2026-11-01")).toBe("AI off: the budget is $0");
    const none = account({ usedMicroUsd: 0, monthlyLimitMicroUsd: 0, custom: false });
    expect(budgetUse(none)).toEqual({ share: 0, usedUp: false, off: true });
    expect(stoppedNote(none, "2026-11-01")).toBeNull();
    expect(noAiUse(none)).toBe(true);
    expect(noAiUse(account({ usedMicroUsd: 0 }))).toBe(false);
  });

  it("names the month, its first day and the day budgets start again, in UTC", () => {
    expect(monthLabel("2026-11-01")).toBe("November 2026");
    expect(monthStartLabel("2026-11-01")).toBe("November 1");
    expect(nextMonthLabel("2026-11-01")).toBe("December 1");
    expect(nextMonthLabel("2026-12-01")).toBe("January 1");
    expect(changedOn("2026-11-03T23:30:00.000Z", "2026-11-01")).toBe("Nov 3");
    expect(changedOn("2025-12-20T08:00:00.000Z", "2026-11-01")).toBe("Dec 20, 2025");
  });

  it("reads the API's error code and message", () => {
    expect(
      problemOf({
        status: 404,
        data: { code: "hotel_account_not_found" },
        message: "API Error: 404",
      }),
    ).toEqual({ status: 404, code: "hotel_account_not_found", message: "API Error: 404" });
    expect(problemOf(new Error("offline"))).toEqual({
      status: undefined,
      code: undefined,
      message: "offline",
    });
  });
});
