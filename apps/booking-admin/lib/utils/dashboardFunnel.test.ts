import { describe, expect, it } from "vitest";
import { funnelCsv, funnelDisplay, funnelRows } from "./dashboardFunnel";

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

describe("dashboard funnel card (VAY-2594)", () => {
  const funnel = (counts: [string, number][]) => ({
    steps: counts.map(([stage, count]) => ({
      stage,
      count,
      previousCount: 0,
      percentOfVisits: null,
      conversionPercent: null,
    })),
    paymentMethods: [],
    biggestDrop: null,
  });

  it("shows six steps, each with its share of the step before, and the overall rate", () => {
    const { rows, overall } = funnelDisplay(
      funnel([
        ["page_visit", 1912],
        ["dates_searched", 846],
        ["rate_selected", 241],
        ["addons_step_passed", 200],
        ["details_completed", 92],
        ["complete_booking_clicked", 26],
        ["payment_authorized", 20],
        ["booking_completed", 18],
      ]),
    );
    expect(rows.map((row) => [row.key, row.count, row.continued])).toEqual([
      ["visitors", 1912, null],
      ["searched", 846, 44],
      ["selected", 241, 28],
      ["details", 92, 38],
      ["payment", 26, 28],
      ["confirmed", 18, 69],
    ]);
    expect(rows[0].width).toBe(100);
    // A thin bar stays visible for a small step.
    expect(rows[5].width).toBe(3);
    expect(overall).toBeCloseTo(0.94, 2);
  });

  it("leaves out a step an older API doesn't send, and has no rate without visitors", () => {
    const { rows, overall } = funnelDisplay(
      funnel([
        ["page_visit", 0],
        ["rate_selected", 0],
        ["booking_completed", 0],
      ]),
    );
    expect(rows.map((row) => row.key)).toEqual(["visitors", "selected", "confirmed"]);
    expect(
      rows.every((row) => row.width === 0 && (row.continued === null || row.continued === 0)),
    ).toBe(true);
    expect(overall).toBeNull();
  });
});
