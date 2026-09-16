import { expect, it } from "vitest";
import { replacementStayKey, type StoredPricingQuote } from "@vayada/domain-booking";
import { historicalQuoteFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { projectPricingBookingAddons as project } from "./pricingBookingAddons.js";
type Mutable<T> = { -readonly [P in keyof T]: Mutable<T[P]> };
type Current = Mutable<Parameters<typeof project>[0]>;
function fixture() {
  const quote = historicalQuoteFixture() as Mutable<StoredPricingQuote>;
  const selection = {
    version: "addon-selection.v2" as const,
    id: "10000000-0000-4000-8000-000000000003",
    quantity: 1,
    people: [
      { selectionId: "one", kind: "adult" as const, index: 1 },
      { selectionId: "one", kind: "child" as const, index: 0 },
    ],
    dates: ["2026-10-02", "2026-10-01"],
  };
  quote.stay.addons = [selection];
  quote.evidence.requestKey = replacementStayKey(quote.stay);
  quote.evidence.lines.push({ id: "addon", kind: "addon", selectionId: null, amountMinor: "2400" });
  quote.evidence.totalMinor = "38400";
  quote.evidence.dueLaterMinor = "27600";
  return {
    kind: "current_quote_price",
    scope: { propertyId: quote.stay.propertyId },
    quote,
    calculation: {
      addons: {
        kind: "addon_components",
        evaluatorVersion: "booking.addon-components.v2",
        sourceRevision: quote.evidence.revisions.addons,
        requestKey: replacementStayKey(quote.stay),
        currency: "EUR",
        totalMinor: "2400",
        lines: [
          {
            definition: {
              id: selection.id,
              name: "Breakfast",
              amountMinor: "600",
              currency: "EUR",
              pricingModel: "per_guest_night",
              maxQuantity: 1,
              maxGuests: 4,
              leadTime: null,
              ownershipKind: "partner",
              partnerCommissionRate: "12.3456",
            },
            quantity: 1,
            people: selection.people,
            dates: [...selection.dates].sort(),
            peopleMultiplier: 2,
            daysMultiplier: 2,
            amountMinor: "2400",
          },
        ],
      },
    },
  } as unknown as Current;
}
function rebind(current: Current, amount?: string, currency?: string) {
  const component = current.calculation.addons;
  if (currency) {
    component.currency = currency;
    current.quote.stay.currency = currency;
    current.quote.evidence.currency = currency;
    component.lines[0].definition.currency = currency;
  }
  if (amount) {
    component.totalMinor = amount;
    component.lines[0].amountMinor = amount;
    current.quote.evidence.lines.find((line) => line.kind === "addon")!.amountMinor = amount;
  }
  component.requestKey = replacementStayKey(current.quote.stay);
  current.quote.evidence.requestKey = component.requestKey;
}
it("splits resolved service-day amounts and preserves complete selected people and owner economics", () => {
  const current = fixture(),
    before = structuredClone(current),
    rows = project(current)!;
  expect(rows.map((row) => [row.serviceDate, row.totalAmount, row.quantity])).toEqual([
    ["2026-10-01", "12.00", 1],
    ["2026-10-02", "12.00", 1],
  ]);
  for (const row of rows) {
    expect(row.ownershipKind).toBe("partner");
    expect(row.partnerCommissionRate).toBe("12.3456");
    expect(row.addonSnapshot).toEqual({
      version: "booking.pricing-addon-selection.v1",
      pricingQuoteId: current.quote.quoteId,
      name: "Breakfast",
      selection: current.quote.stay.addons[0],
      definition: current.calculation.addons.lines[0].definition,
      sourceRevision: "a1",
      serviceDate: row.serviceDate,
      lineAmountMinor: "2400",
      amountMinor: "1200",
    });
  }
  expect(current).toEqual(before);
  current.calculation.addons.lines[0].definition.name = "Changed";
  expect(rows[0].addonSnapshot.definition.name).toBe("Breakfast");
});
it("uses explicit resolved dates for all-night selections without inventing a missing one-time service date", () => {
  const current = fixture();
  current.quote.stay.addons[0].dates = null;
  rebind(current);
  expect(project(current)?.[0].addonSnapshot.selection.dates).toBeNull();
  current.calculation.addons.lines[0].definition.pricingModel = "per_guest";
  current.calculation.addons.lines[0].dates = null;
  expect(project(current)).toBeNull();
});
it("supports property-owned quantity extras and a checkout-day one-time service", () => {
  for (const model of ["per_stay", "per_night", "per_guest"] as const) {
    const current = fixture(),
      line = current.calculation.addons.lines[0],
      selected = current.quote.stay.addons[0];
    line.definition.pricingModel = model;
    line.definition.ownershipKind = "property";
    line.definition.partnerCommissionRate = null;
    if (model !== "per_guest") {
      line.people = null;
      if (selected.version === "addon-selection.v2") selected.people = null;
      line.quantity = selected.quantity = 2;
    }
    if (model !== "per_night") {
      line.dates = selected.dates = ["2026-10-03"];
      line.daysMultiplier = 1;
    }
    rebind(current);
    const rows = project(current)!;
    expect(rows[0]).toMatchObject({
      ownershipKind: "property",
      partnerCommissionRate: null,
      quantity: selected.quantity,
    });
    expect(rows).toHaveLength(model === "per_night" ? 2 : 1);
  }
});
it("conserves exact amounts and rejects rounding, numeric overflow and unknown currencies", () => {
  for (const [currency, minor, expected] of [
    ["JPY", "2", "1.00"],
    ["KWD", "2020", "1.01"],
    ["EUR", "0", "0.00"],
    ["EUR", "1999999999999998", "9999999999999.99"],
  ]) {
    const current = fixture();
    rebind(current, minor, currency);
    expect(project(current)?.map((row) => row.totalAmount)).toEqual([expected, expected]);
  }
  for (const [currency, minor] of [
    ["KWD", "2010"],
    ["EUR", "2401"],
    ["EUR", "2000000000000000"],
    ["FAKE", "2400"],
  ]) {
    const current = fixture();
    rebind(current, minor, currency);
    expect(project(current)).toBeNull();
  }
});
it("rejects mismatched source, selection, dates, amount evidence or owner snapshots", () => {
  const patches: ((current: Current) => void)[] = [
    (c) => {
      c.scope.propertyId = "other";
    },
    (c) => {
      c.calculation.addons.sourceRevision = "changed";
    },
    (c) => {
      c.calculation.addons.requestKey = "changed";
    },
    (c) => {
      c.calculation.addons.totalMinor = "2401";
    },
    (c) => {
      c.calculation.addons.lines[0].amountMinor = "2401";
    },
    (c) => {
      c.calculation.addons.lines[0].quantity = 2;
    },
    (c) => {
      c.calculation.addons.lines[0].people = [];
    },
    (c) => {
      c.calculation.addons.lines[0].definition.partnerCommissionRate = "bad";
    },
    (c) => {
      c.calculation.addons.lines[0].dates = ["2026-10-03"];
    },
    (c) => {
      c.calculation.addons.lines[0].dates = ["2026-10-01", "2026-10-01"];
    },
    (c) => {
      c.calculation.addons.lines[0].daysMultiplier = 1;
    },
    (c) => {
      c.calculation.addons.lines = [];
    },
  ];
  for (const patch of patches) {
    const current = fixture();
    patch(current);
    expect(project(current)).toBeNull();
  }
});
it("returns no rows only for an explicitly empty conserved component", () => {
  const current = fixture();
  current.quote.stay.addons = [];
  current.calculation.addons.lines = [];
  current.calculation.addons.totalMinor = "0";
  current.quote.evidence.lines = current.quote.evidence.lines.filter(
    (line) => line.kind !== "addon",
  );
  rebind(current);
  expect(project(current)).toEqual([]);
  current.calculation.addons.totalMinor = "1";
  expect(project(current)).toBeNull();
});
