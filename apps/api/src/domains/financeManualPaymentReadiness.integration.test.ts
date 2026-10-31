import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createFinanceManualPaymentReadinessReader } from "./financeManualPaymentReadiness.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Finance bank-transfer and PayPal launch readiness (VAY-2139)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(() => pool.end());
  const reader = createFinanceManualPaymentReadinessReader({ pool });
  async function hotel(
    methods: string[],
    options: { bound?: boolean; email?: string; bank?: boolean } = {},
  ) {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Manual readiness test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency,deposit_policy)
       VALUES($1,true,$2,'EUR',$3)`,
      [propertyId, methods, { paypalEmail: options.email ?? "" }],
    );
    if (options.bound !== false) {
      // Committed by either writer: the readiness binding to the PMS pricing currency.
      await pool.query(
        `INSERT INTO pms.property_pricing_settings(property_id,currency,pricing_currency_revision)
         VALUES($1,'EUR',1)`,
        [propertyId],
      );
      await pool.query(
        `UPDATE finance.payment_settings SET payment_readiness_contract_version='finance-payment-readiness.v1',
          payment_methods_revision=1,source_pricing_currency_revision=1 WHERE property_id=$1`,
        [propertyId],
      );
    }
    if (options.bank)
      await pool.query(
        `INSERT INTO finance.bank_transfer_destinations(property_id,revision,ciphertext,key_arn,account_last4)
         VALUES($1,1,$2,'key','3000')`,
        [propertyId, Buffer.alloc(40)],
      );
    const ready = () => reader.readyMethods({ propertyId });
    return Object.assign(ready, {
      accepted: () => reader.acceptedMethods({ propertyId }),
      propertyId,
    });
  }

  it("counts bank transfer and PayPal only with their details, on a committed row", async () => {
    await expect((await hotel(["bank_transfer"], { bank: true }))()).resolves.toEqual([
      "bank_transfer",
    ]);
    await expect((await hotel(["bank_transfer"]))()).resolves.toEqual([]);
    await expect((await hotel(["paypal"], { email: " pay@hotel.example " }))()).resolves.toEqual([
      "paypal",
    ]);
    await expect((await hotel(["paypal"], { email: "not an email" }))()).resolves.toEqual([]);
    await expect(
      (await hotel(["bank_transfer", "paypal"], { bank: true, email: "pay@hotel.example" }))(),
    ).resolves.toEqual(["bank_transfer", "paypal"]);
    // Saved by the settings page before VAY-2136 bound it: not committed yet.
    await expect((await hotel(["bank_transfer"], { bank: true, bound: false }))()).resolves.toEqual(
      [],
    );
  });

  it("offers only the manual methods the booking page takes: bank transfer while PayPal is off", async () => {
    const bankOnly = createFinanceManualPaymentReadinessReader({
      pool,
      methods: ["bank_transfer"],
    });
    const both = await hotel(["bank_transfer", "paypal"], {
      bank: true,
      email: "pay@hotel.example",
    });
    const paypal = await hotel(["paypal"], { email: "pay@hotel.example" });
    await expect(bankOnly.readyMethods({ propertyId: both.propertyId })).resolves.toEqual([
      "bank_transfer",
    ]);
    await expect(bankOnly.acceptedMethods({ propertyId: both.propertyId })).resolves.toEqual([
      "bank_transfer",
    ]);
    // A PayPal-only hotel can't go live, and its rate screens don't offer PayPal.
    await expect(bankOnly.readyMethods({ propertyId: paypal.propertyId })).resolves.toEqual([]);
    await expect(bankOnly.acceptedMethods({ propertyId: paypal.propertyId })).resolves.toEqual([]);
    const cardAndPaypal = await hotel(["card", "paypal"], { email: "pay@hotel.example" });
    await expect(
      bankOnly.acceptedMethods({ propertyId: cardAndPaypal.propertyId }),
    ).resolves.toEqual([]);
  });

  it("leaves hotels with card or pay at property to the usual Finance readiness", async () => {
    const cardAndBank = await hotel(["card", "bank_transfer"], { bank: true });
    await expect(cardAndBank()).resolves.toEqual([]);
    // The owner's setup and rate screens still see bank transfer as set up.
    await expect(cardAndBank.accepted()).resolves.toEqual(["bank_transfer"]);
    await expect(
      (await hotel(["pay_at_property", "paypal"], { email: "pay@hotel.example" }))(),
    ).resolves.toEqual([]);
  });
});
