import Fastify from "fastify";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { registerReplacementPricingRoutes } from "../routes/replacementPricing.js";
import type { PricingCardReadiness } from "./pricingCardReadiness.js";
import { paymentRepublishFixture } from "./pricingPaymentRepublish.fixtures.js";
import { republishPricingAfterPaymentChange } from "./pricingPaymentRepublish.js";
import type { PricingPaymentSwitches } from "./pricingRatePayability.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";
import { sellingPublicOfferKeys } from "./replacementPublicOfferMapping.js";

const url = process.env["TEST_DATABASE_URL"];
const nonRefundableCardOnly = {
  offerId: "nrf",
  cancellation: { kind: "non_refundable" },
  payment: { kind: "full", acceptedMethods: ["card"] },
};
const atProperty = {
  offerId: "pap",
  payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
};
const switches: PricingPaymentSwitches = { card: true, deposits: false, manual: [] };

// VAY-2304: a rate nobody can pay stops selling, every other rate keeps selling, and the hotel sees
// which rate, why, and what fixes it.
describe.skipIf(!url)("rates guests can't pay", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  afterAll(() => pool.end());

  async function hotel(
    ...args: Parameters<typeof paymentRepublishFixture> extends [unknown, ...infer R] ? R : never
  ) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const f = await paymentRepublishFixture(pool, ...args);
    // Card readiness as the PMS rate screens read it (createPricingCardReadinessReader).
    let card: PricingCardReadiness["card"] = {
      ready: false,
      reason: "not_approved",
      charge: "at_booking",
    };
    const app = Fastify();
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      request.authContext = f.context;
    });
    await app.register(registerReplacementPricingRoutes, {
      commands: (context) => createReplacementPricingCommands(pool, context),
      cardReadiness: { read: async () => ({ card, deposits: { ready: false } }) },
    });
    return {
      ...f,
      cardReady(ready: boolean, reason: PricingCardReadiness["card"]["reason"] = null) {
        card = { ready, reason: ready ? null : reason, charge: "at_booking" };
      },
      /** The offers the booking page lists now, by rate. Null: the page offers nothing. */
      async selling(payments = switches) {
        const owner = await f.served();
        if (!owner) return null;
        const keys = sellingPublicOfferKeys(owner, payments);
        return publicPricingOfferBindings(owner)
          .filter((binding) => keys.has(binding.publicOfferKey))
          .map((binding) => binding.offerId)
          .sort();
      },
      async notSelling() {
        const response = await app.inject({
          url: `/properties/${f.propertyId}/pricing-v2/not-selling`,
        });
        expect(response.statusCode).toBe(200);
        return response.json();
      },
      close: () => app.close(),
    };
  }

  it("stops only the card-only rate when card goes off, and names it with the fix", async () => {
    const h = await hotel(["card", "pay_at_property"], true, [nonRefundableCardOnly]);
    try {
      const approval = await h.cardOn();
      h.cardReady(true);
      await (
        await h.save(0)
      )();
      expect(await h.selling()).toEqual(["flex", "nrf"]);
      expect(await h.notSelling()).toEqual({
        version: "pricing-rates-not-selling.v1",
        publishedRevision: 1,
        rates: [],
      });
      // Vayada's card acceptance switched off: the same, without touching the hotel.
      expect(await h.selling({ ...switches, card: false })).toEqual(["flex"]);

      await h.cardOff(approval);
      h.cardReady(false, "not_approved");
      await republishPricingAfterPaymentChange(pool, h.propertyId);
      // Flex is still paid at the property; the non-refundable rate took only card.
      expect(await h.selling()).toEqual(["flex"]);
      expect(await h.notSelling()).toEqual({
        version: "pricing-rates-not-selling.v1",
        publishedRevision: 2,
        rates: [
          {
            roomTypeId: expect.any(String),
            offerId: "nrf",
            reason: "card_off",
            fixes: ["turn_card_on"],
          },
        ],
      });
    } finally {
      await h.close();
    }
  });

  it("offers nothing when no way to pay is left, and the hotel sees every rate with its fix", async () => {
    const h = await hotel(["card", "pay_at_property"], true, [nonRefundableCardOnly, atProperty]);
    try {
      await (
        await h.save(0)
      )();
      expect(await h.selling()).toEqual(["flex", "pap"]);
      // The hotel stops taking payment at the property, and card isn't on.
      await pool.query(
        "UPDATE finance.payment_settings SET accepted_methods=ARRAY['card'] WHERE property_id=$1",
        [h.propertyId],
      );
      expect(await republishPricingAfterPaymentChange(pool, h.propertyId)).toMatchObject({
        outcome: "skipped",
        reason: "finance_unavailable",
        financeReason: "method_unavailable",
      });
      expect(await h.selling()).toBeNull();
      expect((await h.notSelling()).rates).toEqual([
        {
          roomTypeId: expect.any(String),
          offerId: "flex",
          reason: "card_off",
          fixes: ["turn_card_on"],
        },
        {
          roomTypeId: expect.any(String),
          offerId: "nrf",
          reason: "card_off",
          fixes: ["turn_card_on"],
        },
        {
          roomTypeId: expect.any(String),
          offerId: "pap",
          reason: "pay_at_property_off",
          fixes: ["turn_pay_at_property_on"],
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it("tells a hotel that never chose card, or hasn't finished Stripe, what to do", async () => {
    const h = await hotel(["pay_at_property"], false, [
      { ...nonRefundableCardOnly, cancellation: undefined, offerId: "card" },
    ]);
    try {
      await (
        await h.save(0)
      )();
      expect(await h.selling()).toEqual(["flex"]);
      expect((await h.notSelling()).rates).toEqual([
        {
          roomTypeId: expect.any(String),
          offerId: "card",
          reason: "card_not_chosen",
          fixes: ["choose_card", "allow_pay_at_property"],
        },
      ]);
      await pool.query(
        "UPDATE finance.payment_settings SET accepted_methods=ARRAY['card','pay_at_property'] WHERE property_id=$1",
        [h.propertyId],
      );
      h.cardReady(false, "not_connected");
      await republishPricingAfterPaymentChange(pool, h.propertyId);
      expect((await h.notSelling()).rates).toEqual([
        {
          roomTypeId: expect.any(String),
          offerId: "card",
          reason: "card_setup_incomplete",
          fixes: ["finish_stripe_setup", "allow_pay_at_property"],
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it("counts bank transfer only while the booking page takes bank transfer bookings, as the catalog", async () => {
    const h = await hotel(["pay_at_property", "bank_transfer"], false, [
      { offerId: "bank", payment: { kind: "full", acceptedMethods: ["bank_transfer"] } },
    ]);
    try {
      await pool.query(
        `INSERT INTO finance.bank_transfer_destinations (property_id,revision,ciphertext,key_arn,account_last4)
        VALUES($1,1,$2,'key','3000')`,
        [h.propertyId, Buffer.alloc(40)],
      );
      await (
        await h.save(0)
      )();
      const note = async (bankTransfers: boolean) => {
        const app = Fastify();
        app.decorateRequest("authContext", null);
        app.addHook("onRequest", async (request) => {
          request.authContext = h.context;
        });
        await app.register(registerReplacementPricingRoutes, {
          commands: (context) => createReplacementPricingCommands(pool, context),
          manualPayments: { acceptedMethods: async () => ["bank_transfer"] as const },
          bankTransfers,
        });
        try {
          return (
            await app.inject({ url: `/properties/${h.propertyId}/pricing-v2/not-selling` })
          ).json().rates;
        } finally {
          await app.close();
        }
      };
      // Bank transfer acceptance is on, but the booking page has no bank transfer operations.
      expect(await h.selling({ ...switches, manual: ["paypal"] })).toEqual(["flex"]);
      expect(await note(false)).toEqual([
        {
          roomTypeId: expect.any(String),
          offerId: "bank",
          reason: "no_payment_method",
          fixes: ["change_rate_payment"],
        },
      ]);
      expect(await h.selling({ ...switches, manual: ["bank_transfer"] })).toEqual(["bank", "flex"]);
      expect(await note(true)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
