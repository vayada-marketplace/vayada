import { describe, expect, it } from "vitest";
import { funnelCsv, funnelRows } from "./dashboardFunnel";

const step = (stage: string, count: number, previousCount: number, percentOfVisits = 0) => ({
  stage,
  count,
  previousCount,
  percentOfVisits,
  conversionPercent: null,
});

describe("dashboard funnel rows", () => {
  it("drops from the eligible previous step, including the card-only and reunited payment rows", () => {
    const rows = funnelRows({
      steps: [
        step("page_visit", 82, 82, 100),
        step("rate_selected", 41, 82, 50),
        step("complete_booking_clicked", 9, 41, 11),
        // 6 card clicks, 2 authorized; 3 non-card submissions rejoin for completion.
        step("payment_authorized", 2, 6, 2.4),
        step("booking_completed", 4, 5, 4.9),
      ],
      paymentMethods: [],
      biggestDrop: null,
    });
    expect(rows.map(({ drop, dropPercent }) => [drop, dropPercent])).toEqual([
      [null, null],
      [41, 50],
      [32, 78],
      [4, 66.7],
      [1, 20],
    ]);
  });

  it("shows no drop for an empty previous step and never a negative one", () => {
    const rows = funnelRows({
      steps: [
        step("page_visit", 0, 0),
        step("rate_selected", 0, 0),
        step("details_completed", 3, 2),
      ],
      paymentMethods: [],
      biggestDrop: null,
    });
    expect(rows.map((row) => row.drop)).toEqual([null, null, 0]);
  });

  it("exports quoted CSV rows with blank cells for missing values", () => {
    const rows = funnelRows({
      steps: [step("page_visit", 2, 2, 100), step("rate_selected", 1, 2, 50)],
      paymentMethods: [],
      biggestDrop: null,
    });
    expect(
      funnelCsv(rows, "en", ["Step", "Visitors", "%", "Lost", "Lost %"], (s) => `"${s}"`),
    ).toBe(
      [
        '"Step","Visitors","%","Lost","Lost %"',
        '"""page_visit""","2","100","",""',
        '"""rate_selected""","1","50","1","50"',
      ].join("\r\n"),
    );
  });

  it("uses semicolons and comma decimals where spreadsheets expect them", () => {
    const rows = funnelRows({
      steps: [step("page_visit", 3, 3, 100), step("rate_selected", 1, 3, 33.3)],
      paymentMethods: [],
      biggestDrop: null,
    });
    expect(funnelCsv(rows, "de", ["Schritt", "Besucher", "%", "Verloren", "%"], (s) => s)).toBe(
      [
        '"Schritt";"Besucher";"%";"Verloren";"%"',
        '"page_visit";"3";"100";"";""',
        '"rate_selected";"1";"33,3";"2";"66,7"',
      ].join("\r\n"),
    );
  });
});
