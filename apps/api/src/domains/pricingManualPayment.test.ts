import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import {
  lockPricingManualPaymentTerms,
  pricingExpectedPaymentMethod,
  pricingManualQuoteSupported,
} from "./pricingManualPayment.js";

const client = (settings: object | undefined, destinations = 1) =>
  ({
    query: vi.fn(async (sql: string) =>
      sql.includes("bank_transfer_destinations")
        ? { rows: Array.from({ length: destinations }, () => ({ id: "destination" })) }
        : { rows: settings ? [settings] : [] },
    ),
  }) as unknown as Pick<PoolClient, "query">;
const settings = (method: string, depositPolicy: object = {}) => ({
  payments_enabled: true,
  accepted_methods: [method],
  deposit_policy: depositPolicy,
});

describe("pricing manual payment (VAY-2139)", () => {
  it("supports bank transfer and PayPal quotes paid in full before the stay", () => {
    const quote = (method: string, dueLaterMinor = "0") =>
      pricingDraftFixture((q) => {
        Object.assign(q, { paymentMethod: method });
        Object.assign(q.evidence, {
          dueNowMinor: (BigInt(q.evidence.totalMinor) - BigInt(dueLaterMinor)).toString(),
          dueLaterMinor,
        });
      }).current.quote;
    expect(pricingManualQuoteSupported(quote("bank_transfer"))).toBe(true);
    expect(pricingManualQuoteSupported(quote("paypal"))).toBe(true);
    expect(pricingManualQuoteSupported(quote("card"))).toBe(false);
    expect(pricingManualQuoteSupported(quote("bank_transfer", "100"))).toBe(false);
    expect(pricingExpectedPaymentMethod("bank_transfer")).toBe("bank_transfer");
    expect(pricingExpectedPaymentMethod("paypal")).toBe("unknown");
  });

  it("needs an accepted method with an enabled bank destination or a valid PayPal email", async () => {
    await expect(
      lockPricingManualPaymentTerms(client(settings("bank_transfer")), "p", "bank_transfer"),
    ).resolves.toEqual({ method: "bank_transfer", paymentWindowHours: 48, paypalEmail: null });
    for (const [db, method] of [
      [client(settings("bank_transfer"), 0), "bank_transfer"],
      [client(settings("pay_at_property")), "bank_transfer"],
      [
        client({ ...settings("paypal", { paypalEmail: "a@b.co" }), payments_enabled: false }),
        "paypal",
      ],
      [client(settings("paypal", { paypalEmail: "not an email" })), "paypal"],
      [client(undefined), "paypal"],
      [client(settings("card")), "card"],
    ] as const)
      await expect(lockPricingManualPaymentTerms(db, "p", method)).resolves.toBeNull();
  });

  it("uses the hotel's PayPal window within 1-168 hours, otherwise 24", async () => {
    const terms = (hours: unknown) =>
      lockPricingManualPaymentTerms(
        client(
          settings("paypal", {
            paypalEmail: " pay@hotel.example ",
            paypalPaymentWindowHours: hours,
          }),
        ),
        "p",
        "paypal",
      );
    await expect(terms(6)).resolves.toEqual({
      method: "paypal",
      paymentWindowHours: 6,
      paypalEmail: "pay@hotel.example",
    });
    for (const hours of [0, 169, 1.5, null, "x"])
      await expect(terms(hours)).resolves.toMatchObject({ paymentWindowHours: 24 });
  });
});
