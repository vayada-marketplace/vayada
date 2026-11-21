import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { paymentRepublishFixture } from "./pricingPaymentRepublish.fixtures.js";
import type { PricingPaymentSwitches } from "./pricingRatePayability.js";
import { createRatePaymentCoverage } from "./pricingRatePaymentCoverage.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { publicOfferPaymentMethods } from "./replacementPublicOfferMapping.js";

const url = process.env["TEST_DATABASE_URL"];
const switches: PricingPaymentSwitches = {
  card: true,
  deposits: false,
  manual: ["bank_transfer", "paypal"],
};

// VAY-2583: the booking page offers a rate only with the ways to pay its own terms accept that are
// ready at the hotel. Any single way works when the rates take it; a change that would leave no rate
// payable is caught before it is saved.
describe.skipIf(!url)("booking-page rate payment coverage (VAY-2583)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  afterAll(() => pool.end());
  const coverage = createRatePaymentCoverage(pool, switches);

  async function hotel(...args: Parameters<typeof paymentRepublishFixture> extends [unknown, ...infer R] ? R : never) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const f = await paymentRepublishFixture(pool, ...args);
    /** The rates the booking page lists now, each with its ways to pay (null: nothing served). */
    const offered = async () => {
      const owner = await f.served();
      if (!owner) return null;
      const methods = publicOfferPaymentMethods(owner, switches);
      return Object.fromEntries(
        publicPricingOfferBindings(owner).map((binding) => [
          binding.offerId,
          [...(methods.get(binding.publicOfferKey) ?? [])].sort(),
        ]),
      );
    };
    return { ...f, offered };
  }
  const bankDetails = (propertyId: string) =>
    pool.query(
      `INSERT INTO finance.bank_transfer_destinations(property_id,revision,ciphertext,key_arn,account_last4)
       VALUES ($1,1,$2,'key','3000')`,
      [propertyId, Buffer.alloc(40)],
    );

  it("sells with card only when card is ready and the rate takes card", async () => {
    const h = await hotel(["card"], true);
    await (await h.save(0))();
    expect(await h.offered()).toEqual({ flex: ["card"] });
    expect(await coverage(h.propertyId)).toMatchObject({
      payable: 1,
      rates: [
        {
          offerId: "flex",
          roomName: "Garden room",
          cancellation: "flexible",
          acceptedMethods: ["card", "pay_at_property"],
          payableWith: ["card"],
        },
      ],
    });
  });

  it("sells with bank transfer only, and with card and bank transfer together", async () => {
    const transfer = {
      offerId: "transfer",
      payment: { kind: "full", acceptedMethods: ["bank_transfer"] },
    };
    const only = await hotel(["bank_transfer"], false, [transfer]);
    await bankDetails(only.propertyId);
    await (await only.save(0))();
    // The Flexible rate takes only pay at the hotel (off here); the transfer rate sells.
    expect(await only.offered()).toEqual({ flex: [], transfer: ["bank_transfer"] });
    expect(await coverage(only.propertyId)).toMatchObject({ payable: 1 });

    const both = await hotel(["card", "bank_transfer"], true, [transfer]);
    await bankDetails(both.propertyId);
    await (await both.save(0))();
    expect(await both.offered()).toEqual({ flex: ["card"], transfer: ["bank_transfer"] });
    expect(await coverage(both.propertyId)).toMatchObject({ payable: 2 });
  });

  it("tells that card only would leave Aether's rates (pay at hotel only) with no way to pay", async () => {
    // Card on and ready, pay at hotel on, every rate taking only pay at the hotel (Aether, 21 Nov).
    const h = await hotel(["card", "pay_at_property"], false);
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,
        onboarding_status,charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
      VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,
        '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}')`,
      [accountId, h.propertyId, `acct_synthetic_${accountId}`],
    );
    await pool.query("UPDATE finance.payment_settings SET provider_account_id=$2 WHERE property_id=$1", [
      h.propertyId,
      accountId,
    ]);
    await (await h.save(0))();
    expect(await h.offered()).toEqual({ flex: ["pay_at_property"] });
    const rate = {
      offerId: "flex",
      roomName: "Garden room",
      cancellation: "flexible",
      acceptedMethods: ["pay_at_property"],
    };
    expect(await coverage(h.propertyId)).toEqual({
      payable: 1,
      rates: [expect.objectContaining({ ...rate, payableWith: ["pay_at_property"] })],
    });
    // Pay at hotel off: card is ready, but no rate takes it, so nothing could be booked.
    expect(
      await coverage(h.propertyId, { paymentsEnabled: true, acceptedMethods: ["card"] }),
    ).toEqual({ payable: 0, rates: [expect.objectContaining({ ...rate, payableWith: [] })] });
    // Payments off: nothing either; keeping pay at hotel: still bookable.
    expect(
      await coverage(h.propertyId, { paymentsEnabled: false, acceptedMethods: ["card", "pay_at_property"] }),
    ).toMatchObject({ payable: 0 });
    expect(
      await coverage(h.propertyId, { paymentsEnabled: true, acceptedMethods: ["pay_at_property"] }),
    ).toMatchObject({ payable: 1 });
    // Judging the change wrote nothing: the hotel's settings are as saved.
    expect(
      (
        await pool.query(
          "SELECT payments_enabled, accepted_methods FROM finance.payment_settings WHERE property_id=$1",
          [h.propertyId],
        )
      ).rows[0],
    ).toEqual({ payments_enabled: true, accepted_methods: ["card", "pay_at_property"] });
  });

  it("has nothing to say before the first publication", async () => {
    const h = await hotel(["card"], true);
    expect(await coverage(h.propertyId)).toBeNull();
  });
});
