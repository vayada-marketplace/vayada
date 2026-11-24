import { expect, it } from "vitest";
import { refusedPaymentChange } from "../domains/pricingRatePaymentCoverage.js";
import { setupPaymentMethodsChange } from "./financePaymentReadiness.js";

// VAY-2583: setup's payment-methods save is judged as its write leaves the hotel's settings: the
// selection (pay at hotel, card) plus the extras the hotel already takes.
function hotel(saved: string[], rateMethods: string[]) {
  return async (_propertyId: string, proposed?: { acceptedMethods: readonly string[] }) => {
    const methods = proposed ? proposed.acceptedMethods : saved;
    const payable = rateMethods.some((method) => methods.includes(method)) ? 1 : 0;
    return {
      payable,
      rates: [{ acceptedMethods: rateMethods }],
      settings: { paymentsEnabled: true, acceptedMethods: saved },
    };
  };
}

it("keeps a hotel's bank transfer when judging setup's selection (VAY-2583)", async () => {
  // Rates paid by bank transfer; setup changes pay at hotel to card: bank transfer stays, fine.
  await expect(
    refusedPaymentChange(
      hotel(["pay_at_property", "bank_transfer"], ["bank_transfer"]),
      "p",
      setupPaymentMethodsChange(["card"]),
    ),
  ).resolves.toBeNull();
  // The same selection saved again takes nothing away.
  await expect(
    refusedPaymentChange(
      hotel(["pay_at_property", "bank_transfer"], ["bank_transfer"]),
      "p",
      setupPaymentMethodsChange(["pay_at_property"]),
    ),
  ).resolves.toBeNull();
});

it("refuses setup's selection that leaves Aether's rates (pay at hotel only) with no way to pay", async () => {
  const refused = await refusedPaymentChange(
    hotel(["card", "pay_at_property"], ["pay_at_property"]),
    "p",
    setupPaymentMethodsChange(["card"]),
  );
  expect(refused).toMatchObject({ payable: 0 });
  expect(
    setupPaymentMethodsChange(["card"])({
      paymentsEnabled: true,
      acceptedMethods: ["card", "pay_at_property", "paypal"],
    }),
  ).toEqual({
    paymentsEnabled: true,
    acceptedMethods: expect.arrayContaining(["card", "paypal"]),
  });
});
