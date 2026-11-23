import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import type {
  PayoutStatementLine,
  PayoutStatementPayout,
} from "@/services/api/financePayoutStatementClient";
import {
  filterLines,
  formatDigits,
  formatMinor,
  formatPayoutDay,
  lineFigures,
  lineLabel,
  lineNote,
} from "./payoutStatement";

const messages = en as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) => {
  let value = messages[key] ?? key;
  for (const [name, text] of Object.entries(params ?? {}))
    value = value.split(`{${name}}`).join(String(text));
  return value;
};
const line = (overrides: Partial<PayoutStatementLine>): PayoutStatementLine => ({
  id: "line",
  kind: "charge",
  currency: "IDR",
  grossMinor: "0",
  feeMinor: "0",
  netMinor: "0",
  bookingReference: "VAY-7KQ2C",
  checkOut: "2026-11-28",
  occurredAt: "2026-11-24T08:00:00Z",
  fees: null,
  payoutId: null,
  ...overrides,
});
const payout = (overrides: Partial<PayoutStatementPayout>): PayoutStatementPayout => ({
  id: "p1",
  currency: "IDR",
  amountMinor: "800000000",
  accountLast4: "1102",
  startedOn: "2026-11-09",
  paidOn: "2026-11-09",
  returnedOn: "2026-11-12",
  status: "returned",
  ...overrides,
});

// Dates in notes leave out the year when it is this year.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("payout statement figures (VAY-2584)", () => {
  it("shows money as Vayada Admin does: IDR in whole rupiah unless there is a part, any size", () => {
    expect(formatMinor("1845000000", "IDR")).toBe("IDR 18,450,000");
    expect(formatMinor("3620000050", "IDR")).toBe("IDR 36,200,000.50");
    expect(formatMinor("-6380000000", "IDR")).toBe("IDR −63,800,000");
    expect(formatMinor("1250", "EUR")).toBe("EUR 12.50");
    expect(formatMinor("4500", "JPY")).toBe("JPY 4,500");
    expect(formatMinor("123456789012345678901234", "IDR")).toBe(
      "IDR 1,234,567,890,123,456,789,012.34",
    );
    expect(formatDigits("175000000", "IDR", true)).toBe("+1,750,000");
    expect(formatDigits("0", "IDR", true)).toBe("0");
    expect(formatDigits("-0", "IDR")).toBe("0");
  });

  it("names days the way the design does, with the year only when it isn't this year", () => {
    const today = new Date("2026-11-25T10:00:00Z");
    expect(formatPayoutDay("2026-11-30", "en", today)).toBe("Mon 30 Nov");
    expect(formatPayoutDay("2026-11-24T23:30:00Z", "en", today)).toBe("Tue 24 Nov");
    // With a year, ICU puts a comma after the weekday ("Mon, 29 Dec 2025").
    expect(formatPayoutDay("2025-12-29", "en", today)).toMatch(/^Mon,? 29 Dec 2025$/);
    expect(formatPayoutDay("2026-11-30", "de", today)).toContain("30");
  });

  it("reads each line's figures: card payments plain, everything else signed, fees shown taken", () => {
    expect(
      lineFigures(line({ grossMinor: "320000000", feeMinor: "44800000", netMinor: "275200000" })),
    ).toEqual({ amount: "3,200,000", fees: "−448,000", net: "2,752,000", tone: "plain" });
    expect(
      lineFigures(
        line({
          kind: "refund",
          grossMinor: "-150000000",
          feeMinor: "-12000000",
          netMinor: "-138000000",
        }),
      ),
    ).toEqual({ amount: "−1,500,000", fees: "+120,000", net: "−1,380,000", tone: "negative" });
    expect(
      lineFigures(line({ kind: "dispute_fee", feeMinor: "40500000", netMinor: "-40500000" })),
    ).toEqual({ amount: "", fees: "−405,000", net: "−405,000", tone: "negative" });
    expect(
      lineFigures(
        line({ kind: "payout_returned", grossMinor: "800000000", netMinor: "800000000" }),
      ),
    ).toEqual({ amount: "", fees: "", net: "+8,000,000", tone: "positive" });
    expect(
      lineFigures(line({ kind: "payout", grossMinor: "-912000000", netMinor: "-912000000" })),
    ).toEqual({ amount: "", fees: "", net: "−9,120,000", tone: "negative" });
  });

  it("filters card payments and deductions", () => {
    const lines = [
      line({ id: "charge" }),
      line({ id: "refund", kind: "refund" }),
      line({ id: "dispute", kind: "dispute" }),
      line({ id: "fee", kind: "dispute_fee" }),
      line({ id: "won", kind: "dispute_reversal" }),
      line({ id: "minus", kind: "adjustment", netMinor: "-100" }),
      line({ id: "plus", kind: "adjustment", netMinor: "100" }),
      line({ id: "payout", kind: "payout" }),
    ];
    expect(filterLines(lines, "all")).toHaveLength(8);
    expect(filterLines(lines, "card").map((l) => l.id)).toEqual(["charge"]);
    expect(filterLines(lines, "deductions").map((l) => l.id)).toEqual([
      "refund",
      "dispute",
      "fee",
      "minus",
    ]);
  });
});

describe("payout statement wording (VAY-2584)", () => {
  it("names every kind of line, and a returned payout as cancelled when it was never sent", () => {
    for (const kind of [
      "charge",
      "refund",
      "dispute",
      "dispute_reversal",
      "dispute_fee",
      "dispute_fee_returned",
      "payout",
      "payout_returned",
      "adjustment",
    ] as const)
      expect(messages).toHaveProperty(`settings.payouts.kind.${kind}`);
    const returned = line({ kind: "payout_returned", payoutId: "p1" });
    expect(lineLabel(returned, [payout({})], t)).toBe("Payout returned");
    expect(lineLabel(returned, [payout({ status: "cancelled", paidOn: null })], t)).toBe(
      "Payout cancelled",
    );
    expect(lineLabel(line({ kind: "dispute_fee" }), [], t)).toBe("Answered dispute lost");
  });

  it("explains each line in the hotel's words", () => {
    const note = (overrides: Partial<PayoutStatementLine>, payouts: PayoutStatementPayout[] = []) =>
      lineNote(line(overrides), payouts, t, "en");
    expect(
      note({
        feeMinor: "44800000",
        fees: { planMinor: "25600000", vayadaMinor: "19200000", vayadaPercent: 6 },
      }),
    ).toBe("Fees: your plan's booking fee (IDR 256,000) and vayada Payment's 6% (IDR 192,000).");
    expect(note({ fees: { planMinor: "0", vayadaMinor: "19200000", vayadaPercent: 6 } })).toBe(
      "Fees: vayada Payment's 6% (IDR 192,000).",
    );
    expect(note({})).toBeNull();
    expect(note({ kind: "refund", grossMinor: "-150000000", feeMinor: "-12000000" })).toBe(
      "The guest got IDR 1,500,000 back. Your plan's fee on it comes back; vayada Payment's fee is kept.",
    );
    expect(note({ kind: "refund", grossMinor: "-150000000" })).toBe(
      "The guest got IDR 1,500,000 back. vayada Payment's fee is kept.",
    );
    expect(note({ kind: "refund", grossMinor: "0" })).toContain("had already taken this money");
    expect(note({ kind: "dispute", grossMinor: "-240000000" })).toContain(
      "Stripe's dispute fee come off your payouts",
    );
    expect(note({ kind: "dispute", grossMinor: "0" })).toContain("already been refunded");
    expect(note({ kind: "dispute_fee" })).toContain("answered dispute is lost");
    expect(note({ kind: "payout_returned", payoutId: "p1" }, [payout({})])).toBe(
      "The Mon 9 Nov payout came back from the bank. It was added to what you're owed again.",
    );
    expect(
      note({ kind: "payout_returned", payoutId: "p1" }, [
        payout({ status: "cancelled", paidOn: null, startedOn: "2026-11-23" }),
      ]),
    ).toContain("started on Mon 23 Nov was cancelled");
    expect(note({ kind: "payout" })).toBeNull();
  });
});
