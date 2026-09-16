import { expect, it } from "vitest";
import { readChannexAirbnbAlterationFinancialSnapshot as read } from "./channexAirbnbAlterationFinancialSnapshot.js";

const id = (last: number) => `82000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const scope = {
  revisionId: "revision-2",
  providerPropertyId: id(1),
  providerBookingId: id(2),
  currency: "EUR",
  checkIn: "2026-09-01",
  checkOut: "2026-09-04",
  rooms: [{ providerRoomTypeId: id(3), roomTypeId: id(4) }],
};
const settings = {
  booking_amount_settings: "Payout Amount" as const,
  cohost_payout_calculations: false,
};
const make = () => ({
  id: scope.revisionId,
  property_id: scope.providerPropertyId,
  booking_id: scope.providerBookingId,
  status: "modified",
  ota_name: "Airbnb",
  currency: "EUR",
  arrival_date: scope.checkIn,
  departure_date: scope.checkOut,
  amount: "100.00",
  ota_commission: "10.00",
  amount_type: "not-a-booking-basis",
  notes: "PRIVATE GUEST: withheld tax 99.00",
  customer: { name: "PRIVATE GUEST" },
  rooms: [
    {
      room_type_id: id(3),
      amount: "100.00",
      days: { "2026-09-01": "33.33", "2026-09-02": "33.33", "2026-09-03": "33.34" },
      taxes: [{ type: "tax", total_price: "5.00", is_inclusive: true, name: "PRIVATE GUEST" }],
      collected_taxes: [{ total_price: "99.00" }],
    },
  ],
});

it("replaces canceled nights without interpreting the provider total as a refund", () => {
  const original = make();
  const { rooms: _rooms, ota_commission: _commission, ...raw } = original;
  const result = read({ ...raw, status: "cancelled", amount: "25.00" }, scope, settings);
  expect(result).toMatchObject({
    replacement: "cancellation",
    nightlyAllocation: "unavailable",
    providerBookingAmount: "25.00",
    otaCommission: null,
    nights: [],
    rooms: [],
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE GUEST");
  expect(() => read({ ...raw, status: "cancelled", booking_id: id(9) }, scope, settings)).toThrow();
  expect(() => read({ ...raw, status: "cancelled", amount: undefined }, scope, settings)).toThrow();
});

it.each(["Payout Amount", "Total Paid Amount"] as const)(
  "preserves %s amounts and separate commission without a second deduction or gross-up",
  (basis) => {
    const raw = make();
    const result = read(raw, scope, { ...settings, booking_amount_settings: basis });
    expect(result.amountBasis).toBe(basis);
    expect(result.providerBookingAmount).toBe("100.00");
    expect(result.rooms[0]!.providerRoomAmount).toBe("100.00");
    expect(result.nights.map((night) => night.providerNightlyAmount)).toEqual([
      "33.33",
      "33.33",
      "33.34",
    ]);
    expect(result.otaCommission).toBe("10.00");
    expect(result.nightlyAllocation).toBe("provider_allocated");
    expect(result.rooms[0]!.taxes).toEqual([
      { amount: "5.00", includedInRoomAmount: true, type: "tax" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE GUEST|99.00|grossRoomAmount|amount_type/);
    expect(
      read({ data: { id: raw.id, attributes: raw } }, scope, {
        ...settings,
        booking_amount_settings: basis,
      }),
    ).toEqual(result);
  },
);

it.each([true, false, null])(
  "preserves co-host setting %s without guessing a deduction",
  (cohost) => {
    const result = read(make(), scope, { ...settings, cohost_payout_calculations: cohost });
    expect(result.cohostPayoutCalculations).toBe(cohost);
    expect(result.providerBookingAmount).toBe("100.00");
  },
);

it("returns only the complete updated stay, including unchanged nights, on replacement and replay", () => {
  const raw = make();
  const before = read(raw, scope, settings);
  const revised = {
    ...raw,
    id: "revision-3",
    departure_date: "2026-09-03",
    amount: "80.00",
    ota_commission: "8.00",
    rooms: [
      { ...raw.rooms[0]!, amount: "80.00", days: { "2026-09-01": "40.00", "2026-09-02": "40.00" } },
    ],
  };
  const updatedScope = { ...scope, revisionId: revised.id, checkOut: revised.departure_date };
  const after = read(revised, updatedScope, settings);
  expect(before.nights).toHaveLength(3);
  expect(after.replacement).toBe("full_stay");
  expect(after.nights.map((night) => [night.stayDate, night.providerNightlyAmount])).toEqual([
    ["2026-09-01", "40.00"],
    ["2026-09-02", "40.00"],
  ]);
  expect(after.otaCommission).toBe("8.00");
  expect(read(revised, updatedScope, settings)).toEqual(after);
});

it("preserves explicit zero, missing commission and unknown versus empty taxes", () => {
  const raw = make();
  const result = read(
    {
      ...raw,
      amount: "0.00",
      ota_commission: null,
      rooms: [
        {
          ...raw.rooms[0],
          amount: "0.00",
          taxes: null,
          days: { "2026-09-01": "0", "2026-09-02": "0", "2026-09-03": "0" },
        },
      ],
    },
    scope,
    settings,
  );
  expect(result.providerBookingAmount).toBe("0.00");
  expect(result.otaCommission).toBeNull();
  expect(result.rooms[0]!.taxes).toBeNull();
  expect(result.nights.every((night) => night.providerNightlyAmount === "0")).toBe(true);
  expect(
    read({ ...raw, rooms: [{ ...raw.rooms[0], taxes: [] }] }, scope, settings).rooms[0]!.taxes,
  ).toEqual([]);
});

it.each([
  { ota_name: "Booking.com" },
  { property_id: id(8) },
  { booking_id: id(8) },
  { id: "stale" },
  { currency: "USD" },
  { amount: "NaN" },
  { ota_commission: "-1" },
  { rooms: [{ ...make().rooms[0], days: { "2026-09-01": "100.00" } }] },
  { rooms: [{ ...make().rooms[0], taxes: [{ type: "tax", total_price: "5" }] }] },
])("rejects unsupported or incomplete financial snapshots %j", (override) => {
  expect(() => read({ ...make(), ...override }, scope, settings)).toThrow(
    "airbnb_alteration_financial_snapshot_invalid",
  );
});

it("never uses revision amount_type as a fallback for missing channel settings", () => {
  expect(() =>
    read(make(), scope, { ...settings, booking_amount_settings: null } as never),
  ).toThrow("airbnb_alteration_financial_snapshot_invalid");
  expect(() =>
    read(make(), scope, { ...settings, booking_amount_settings: "unknown" } as never),
  ).toThrow("airbnb_alteration_financial_snapshot_invalid");
});
