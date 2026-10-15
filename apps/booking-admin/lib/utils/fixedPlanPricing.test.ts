import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { fixedPlanUnitPrices, formatBillingAmount } from "./fixedPlanPricing";

describe("fixed plan pricing", () => {
  it("matches the prices finance charges", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/domain-finance/src/subscriptions.ts"),
      "utf8",
    );
    const catalog = Array.from(
      source.matchAll(/(\w{3}): \{ baseAmountMinor: ([\d_]+), extraRoomAmountMinor: ([\d_]+) \}/g),
    );
    expect(catalog.length).toBeGreaterThan(0);
    for (const [, currency, base, extra] of catalog) {
      expect(fixedPlanUnitPrices(currency!), currency).toEqual({
        baseAmountMinor: Number(base!.replaceAll("_", "")),
        extraUnitAmountMinor: Number(extra!.replaceAll("_", "")),
      });
    }
    expect(fixedPlanUnitPrices("GBP")).toBeNull();
  });

  it("shows the plan's own currency", () => {
    expect(formatBillingAmount(5_500, "USD", "en")).toBe("$55.00");
    expect(formatBillingAmount(5_500, "EUR", "en")).toBe("€55.00");
    expect(formatBillingAmount(3_000, "USD", "en", { whole: true })).toBe("$30");
    expect(formatBillingAmount(3_050, "USD", "en", { whole: true })).toBe("$30.50");
    expect(formatBillingAmount(50_000_000, "IDR", "en", { whole: true })).toBe("IDR\u00a0500,000");
  });
});
