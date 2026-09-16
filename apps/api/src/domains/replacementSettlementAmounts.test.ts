import { describe, expect, it } from "vitest";
import { composeReplacementSettlementAmounts as compose } from "./replacementSettlementAmounts.js";
const charge = (amountMinor = "6000", included = false, collect = "online") => ({
  id: "tax",
  amountMinor,
  included,
  collect,
  basisEvidenceId: "resolved-tax-1",
});
const input = () => ({
  subtotalMinor: "30000",
  charges: [charge()],
  payment: { kind: "deposit", basisPoints: 3000 },
});
describe("resolved charge and settlement arithmetic", () => {
  it("applies the agreed deposit to the whole final total", () => {
    expect(compose(input())).toMatchObject({
      totalMinor: "36000",
      dueNowMinor: "10800",
      dueLaterMinor: "25200",
      additionalChargeMinor: "6000",
      includedChargeMinor: "0",
    });
    expect(compose({ ...input(), payment: { kind: "full" } })).toMatchObject({
      dueNowMinor: "36000",
      dueLaterMinor: "0",
    });
    expect(compose({ ...input(), payment: { kind: "pay_at_property" } })).toMatchObject({
      dueNowMinor: "0",
      dueLaterMinor: "36000",
    });
  });
  it("does not add included charges twice and retains property collection", () => {
    const charges = [
      charge("3000", true, "property"),
      { ...charge("2000", false, "property"), id: "fee" },
    ];
    expect(compose({ ...input(), charges, payment: { kind: "full" } })).toMatchObject({
      totalMinor: "32000",
      includedChargeMinor: "3000",
      additionalChargeMinor: "2000",
      propertyCollectedMinor: "5000",
      onlineCollectibleMinor: "27000",
      dueNowMinor: "27000",
      dueLaterMinor: "5000",
    });
    expect(compose({ ...input(), charges })).toMatchObject({
      dueNowMinor: "9600",
      dueLaterMinor: "22400",
    });
    expect(compose({ ...input(), charges: [charge("30000", true, "property")] })).toBeNull();
    expect(compose({ ...input(), charges: [charge("30001", true)] })).toBeNull();
  });
  it("uses bounded integer arithmetic with exact half-up rounding", () => {
    expect(
      compose({
        ...input(),
        subtotalMinor: "1",
        charges: [],
        payment: { kind: "deposit", basisPoints: 5000 },
      }),
    ).toMatchObject({ dueNowMinor: "1", dueLaterMinor: "0" });
    expect(compose({ ...input(), subtotalMinor: "12500", charges: [] })).toMatchObject({
      dueNowMinor: "3750",
      dueLaterMinor: "8750",
    });
    expect(
      compose({
        ...input(),
        subtotalMinor: "999999999999999999",
        charges: [],
        payment: { kind: "full" },
      })?.totalMinor,
    ).toBe("999999999999999999");
    expect(
      compose({ ...input(), subtotalMinor: "999999999999999999", charges: [charge("1")] }),
    ).toBeNull();
    expect(compose({ ...input(), subtotalMinor: "0", charges: [] })).toBeNull();
  });
  it("requires explicit owner amounts and rejects malformed or ambiguous inputs", () => {
    for (const change of [
      { charges: null },
      { charges: [charge(), charge()] },
      { charges: new Array(1) },
      { charges: [{ ...charge(), basisEvidenceId: "" }] },
      { charges: [{ ...charge(), collect: "cash" }] },
      { charges: [{ ...charge(), included: 1 }] },
      { charges: [{ ...charge(), rate: 10 }] },
      { subtotalMinor: "1.00" },
      { subtotalMinor: "-1" },
      { subtotalMinor: 30000 },
      { currency: "EUR" },
      { payment: { kind: "full", basisPoints: 10000 } },
      { payment: { kind: "deposit", basisPoints: 0 } },
      { payment: { kind: "deposit", basisPoints: 10001 } },
      { payment: { kind: "deposit", basisPoints: 12.5 } },
      { charges: Array.from({ length: 100 }, (_, i) => ({ ...charge(), id: String(i) })) },
    ])
      expect(compose({ ...input(), ...change })).toBeNull();
    const request = input(),
      result = compose(request)!;
    request.charges[0].amountMinor = "1";
    expect(result.charges[0].amountMinor).toBe("6000");
    expect(compose({ ...input(), charges: [] })).toMatchObject({
      totalMinor: "30000",
      additionalChargeMinor: "0",
    });
  });
});
