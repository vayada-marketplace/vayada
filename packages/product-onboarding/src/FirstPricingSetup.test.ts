import { expect, it } from "vitest";
import { firstPricingInput } from "./FirstPricingSetup";
import { englishPricingSetup } from "./firstPricingSetupMessages";
import { includedPrice } from "./IncludedPricing";
import { parseMinorInput } from "./pricingSetupAmounts";

const id = "61000000-0000-4000-8000-000000000001";
const room = { roomTypeId: id, name: "Double", capacity: { total: 2, adults: 2, children: 1 } };
const values = {
  mode: "flat",
  occupancy: [] as string[],
  included: { adults: "", adjustments: [] },
  methods: ["pay_at_property"] as ("card" | "pay_at_property")[],
  room: id,
  currency: "IDR",
  base: "1500000",
  adultAge: "12",
  childPrice: "0",
  countChildren: "yes",
  minimum: "1",
  maximum: "",
  cancellation: "flexible",
  freeDays: "7",
  payment: "full",
};
const wholeRupiah = englishPricingSetup("pricing.error.wholeUnitsOnly");

it("prices IDR first setups in whole rupiah (VAY-2085)", () => {
  expect(wholeRupiah).toBe("Enter a whole amount without decimals: IDR prices are whole rupiah.");
  expect(firstPricingInput(id, room, id, values).configuration.offers[0].price).toMatchObject({
    calendar: { base: { mode: "flat", amountMinor: "150000000" } },
  });
  expect(
    firstPricingInput(id, room, id, { ...values, base: "1500000.00" }).configuration.offers[0]
      .price,
  ).toMatchObject({ calendar: { base: { amountMinor: "150000000" } } });
  for (const invalid of [
    { base: "1500000.50" },
    { mode: "per_person", base: "750000.5" },
    { mode: "occupancy", occupancy: ["1000000", "1500000.25"] },
    { childPrice: "50000.50" },
  ])
    expect(() => firstPricingInput(id, room, id, { ...values, ...invalid })).toThrow(wholeRupiah);
  // Other currencies keep their minor units.
  expect(
    firstPricingInput(id, room, id, { ...values, currency: "EUR", base: "123.45" }).configuration
      .offers[0].price,
  ).toMatchObject({ calendar: { base: { amountMinor: "12345" } } });
});

it("keeps included-guest IDR adjustments whole and rounds percentages like the calculator", () => {
  const included = (adjustment: { kind: string; value: string }) =>
    includedPrice(
      { adults: "1", adjustments: [{ kind: "fixed", value: "0" }, adjustment] },
      "1",
      2,
      2,
      100,
    );
  expect(() => included({ kind: "fixed", value: "+0.50" })).toThrow(wholeRupiah);
  expect(included({ kind: "fixed", value: "+250000" }).adjustments[1]).toEqual({
    kind: "fixed",
    deltaMinor: "25000000",
  });
  // 49% off Rp 1 leaves Rp 0.51 -> Rp 1; 51% off leaves Rp 0.49 -> Rp 0, which is refused.
  expect(included({ kind: "percentage", value: "-49" }).adjustments[1]).toEqual({
    kind: "percentage",
    basisPoints: -4900,
  });
  expect(() => included({ kind: "percentage", value: "-51" })).toThrow("positive");
  expect(parseMinorInput("12.50", 2)).toBe("1250");
  expect(() => parseMinorInput("12.50", 2, false, 100)).toThrow(wholeRupiah);
});
