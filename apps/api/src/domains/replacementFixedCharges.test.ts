import { describe, expect, it } from "vitest";
import {
  calculateReplacementFixedCharges as calculate,
  parseFixedChargePolicy,
} from "./replacementFixedCharges.js";
import { composeReplacementSettlementAmounts as settle } from "./replacementSettlementAmounts.js";
const stay = () => ({
  propertyId: "hotel",
  checkIn: "2026-10-01",
  checkOut: "2026-10-04",
  currency: "EUR",
  rooms: [
    {
      selectionId: "one",
      roomTypeId: "room",
      offerId: "flex",
      guests: { adults: 2, childAgesAtCheckIn: [5, 12] },
    },
  ],
  addons: [],
  promoCode: null,
});
const rule = () => ({
  id: "city",
  name: "Configured fee",
  unit: "person_night",
  amountMinor: "300",
  minimumAge: 18,
  included: false,
  collect: "property",
});
const policy = () => ({ version: "booking.fixed-charges.v1", currency: "EUR", charges: [rule()] });
describe("explicit fixed charge calculation", () => {
  it("calculates €3 per adult per night for two adults and three nights as €18", () => {
    const result = calculate(stay(), policy())!;
    expect(result.additionalChargeMinor).toBe("1800");
    expect(result.charges[0].quantity).toBe(6);
    expect(
      settle({
        subtotalMinor: "30000",
        payment: { kind: "full" },
        charges: result.charges.map(({ id, amountMinor, included, collect, basisEvidenceId }) => ({
          id,
          amountMinor,
          included,
          collect,
          basisEvidenceId,
        })),
      }),
    ).toMatchObject({ totalMinor: "31800", dueNowMinor: "30000", dueLaterMinor: "1800" });
  });
  it("uses configured child ages at check-in and counts separate rooms", () => {
    for (const [minimumAge, total] of [
      [0, "3600"],
      [6, "2700"],
      [12, "2700"],
      [13, "1800"],
      [18, "1800"],
    ])
      expect(
        calculate(stay(), { ...policy(), charges: [{ ...rule(), minimumAge }] })
          ?.additionalChargeMinor,
      ).toBe(total);
    const s = stay();
    s.rooms.push({ ...s.rooms[0], selectionId: "two" });
    for (const [unit, quantity] of [
      ["booking", 1],
      ["room", 2],
      ["night", 3],
      ["room_night", 6],
      ["person", 4],
      ["person_night", 12],
    ]) {
      const r = { ...rule(), unit, minimumAge: String(unit).startsWith("person") ? 18 : null };
      expect(calculate(s, { ...policy(), charges: [r] })?.charges[0].quantity).toBe(quantity);
    }
  });
  it("preserves explicit no-charge and included outcomes without adding included fees twice", () => {
    expect(calculate(stay(), { ...policy(), charges: [] })).toMatchObject({
      charges: [],
      additionalChargeMinor: "0",
    });
    expect(
      calculate(stay(), { ...policy(), charges: [{ ...rule(), included: true }] }),
    ).toMatchObject({ includedChargeMinor: "1800", additionalChargeMinor: "0" });
    const p = policy(),
      result = calculate(stay(), p)!;
    p.charges[0].amountMinor = "1";
    expect(result.charges[0].rule.amountMinor).toBe("300");
    const reordered = JSON.parse(
      JSON.stringify(policy(), (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    );
    expect(calculate(stay(), reordered)?.basisEvidenceId).toBe(result.basisEvidenceId);
    expect(calculate(stay(), p)?.basisEvidenceId).not.toBe(result.basisEvidenceId);
    expect(calculate({ ...stay(), checkOut: "2026-10-05" }, policy())?.basisEvidenceId).not.toBe(
      result.basisEvidenceId,
    );
  });
  it("rejects missing, unsupported, ambiguous and overflowing settings", () => {
    for (const p of [
      null,
      {},
      { ...policy(), currency: "USD" },
      { ...policy(), charges: [rule(), rule()] },
      { ...policy(), charges: new Array(1) },
      ...[-1, 19, 0.5, null].map((minimumAge) => ({
        ...policy(),
        charges: [{ ...rule(), minimumAge }],
      })),
      { ...policy(), charges: [{ ...rule(), unit: "percentage" }] },
      { ...policy(), charges: [{ ...rule(), rate: 10 }] },
      { ...policy(), charges: [{ ...rule(), amountMinor: "1.00" }] },
      { ...policy(), charges: [{ ...rule(), amountMinor: "999999999999999999" }] },
    ])
      expect(calculate(stay(), p)).toBeNull();
    expect(
      parseFixedChargePolicy({
        ...policy(),
        charges: [{ ...rule(), unit: "night", minimumAge: 18 }],
      }),
    ).toBeNull();
    expect(calculate({ ...stay(), checkOut: "2028-10-04" }, policy())).toBeNull();
  });
});
