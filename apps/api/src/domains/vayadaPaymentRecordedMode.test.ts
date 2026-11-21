import { describe, expect, it, vi } from "vitest";
import { createVayadaPaymentRecordedMode } from "./vayadaPaymentRecordedMode.js";

const propertyId = "25690000-0000-4000-8000-000000000001";

function poolWith(...livemodes: (string | null)[]) {
  return { query: vi.fn(async () => ({ rows: livemodes.map((livemode) => ({ livemode })) })) };
}

describe("vayada Payment's recorded mode (VAY-2569)", () => {
  it("reads the mode a payment was made in, by its PaymentIntent or a refund of it, for one hotel", async () => {
    for (const [rows, mode] of [
      [["true"], true],
      [["false"], false],
      [[null], null],
      [[], null],
      [["true", "true"], true],
    ] as const) {
      const pool = poolWith(...rows);
      await expect(
        createVayadaPaymentRecordedMode(pool as never)({ propertyId, paymentIntentId: "pi_1" }),
      ).resolves.toBe(mode);
    }
    const byIntent = poolWith("true");
    await createVayadaPaymentRecordedMode(byIntent as never)({
      propertyId,
      paymentIntentId: "pi_1",
    });
    expect(byIntent.query).toHaveBeenCalledWith(expect.stringContaining("FROM finance.payments"), [
      propertyId,
      "pi_1",
    ]);
    const byRefund = poolWith("false");
    await expect(
      createVayadaPaymentRecordedMode(byRefund as never)({ propertyId, refundId: "re_1" }),
    ).resolves.toBe(false);
    expect(byRefund.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM finance.card_refund_commands"),
      [propertyId, "re_1"],
    );
  });

  it("refuses a payment recorded in two modes and asks nothing without an id", async () => {
    await expect(
      createVayadaPaymentRecordedMode(poolWith("true", "false") as never)({
        propertyId,
        paymentIntentId: "pi_1",
      }),
    ).rejects.toThrow("recorded in two modes");
    const pool = poolWith("true");
    await expect(
      createVayadaPaymentRecordedMode(pool as never)({ propertyId }),
    ).resolves.toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
