import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { stayCurrencyFee } from "./domains/vayadaPaymentWebhookEvents.js";
import { registerVayadaPaymentWebhookRoutes } from "./routes/vayadaPaymentWebhooks.js";

const secret = "whsec_vay2442test";
const now = new Date("2026-11-01T12:00:00Z");

function signed(body: string, key = secret) {
  const t = Math.floor(now.getTime() / 1000);
  const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function appWith(handle = vi.fn(async () => "handled" as const)) {
  const app = Fastify();
  await app.register(registerVayadaPaymentWebhookRoutes, { secret, handle, now: () => now });
  return { app, handle };
}

describe("vayada Payment's Stripe webhook (VAY-2442)", () => {
  const event = { id: "evt_1", type: "payment_intent.succeeded", livemode: false, data: {} };
  const post = (app: Awaited<ReturnType<typeof appWith>>["app"], body: string, signature: string) =>
    app.inject({
      method: "POST",
      url: "/webhooks/stripe/vayada-payment",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: body,
    });

  it("hands only events signed with vayada Payment's own secret to the handler", async () => {
    const { app, handle } = await appWith();
    try {
      const body = JSON.stringify(event);
      const ok = await post(app, body, signed(body));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ received: true, handled: true });
      expect(handle).toHaveBeenCalledWith(event);
      for (const signature of [signed(body, "whsec_other"), "t=1,v1=00", ""]) {
        const refused = await post(app, body, signature);
        expect(refused.statusCode).toBe(400);
      }
      expect(handle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("refuses connected-account events and leaves live events alone (test mode only)", async () => {
    const { app, handle } = await appWith();
    try {
      const connected = JSON.stringify({ ...event, account: "acct_hotel" });
      expect((await post(app, connected, signed(connected))).statusCode).toBe(400);
      const live = JSON.stringify({ ...event, livemode: true });
      const answer = await post(app, live, signed(live));
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toEqual({ received: true, handled: false });
      const broken = "{not json";
      expect((await post(app, broken, signed(broken))).statusCode).toBe(400);
      expect(handle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("takes live events only on the live endpoint, signed with the live secret", async () => {
    const liveSecret = "whsec_vay2442live";
    const handleTest = vi.fn(async () => "handled" as const);
    const handleLive = vi.fn(async () => "handled" as const);
    // As buildApp registers them: both endpoints side by side, each with its own secret.
    const app = Fastify();
    await app.register(registerVayadaPaymentWebhookRoutes, {
      secret,
      livemode: false,
      handle: handleTest,
      now: () => now,
    });
    await app.register(registerVayadaPaymentWebhookRoutes, {
      secret: liveSecret,
      livemode: true,
      handle: handleLive,
      now: () => now,
    });
    const send = (url: string, body: string, signature: string) =>
      app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: body,
      });
    try {
      const liveEvent = { ...event, id: "evt_live", livemode: true };
      const live = JSON.stringify(liveEvent);
      const ok = await send("/webhooks/stripe/vayada-payment-live", live, signed(live, liveSecret));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ received: true, handled: true });
      expect(handleLive).toHaveBeenCalledWith(liveEvent);
      // The test secret can't sign for the live endpoint, nor the live secret for the test one.
      expect(
        (await send("/webhooks/stripe/vayada-payment-live", live, signed(live))).statusCode,
      ).toBe(400);
      expect(
        (await send("/webhooks/stripe/vayada-payment", live, signed(live, liveSecret))).statusCode,
      ).toBe(400);
      // A test event on the live endpoint, or a live one on the test endpoint, is left alone.
      const test = JSON.stringify(event);
      const crossedLive = await send(
        "/webhooks/stripe/vayada-payment-live",
        test,
        signed(test, liveSecret),
      );
      expect(crossedLive.json()).toEqual({ received: true, handled: false });
      const crossedTest = await send("/webhooks/stripe/vayada-payment", live, signed(live));
      expect(crossedTest.json()).toEqual({ received: true, handled: false });
      // A connected-account event is refused on the live endpoint too.
      const connected = JSON.stringify({ ...liveEvent, account: "acct_hotel" });
      expect(
        (
          await send(
            "/webhooks/stripe/vayada-payment-live",
            connected,
            signed(connected, liveSecret),
          )
        ).statusCode,
      ).toBe(400);
      expect(handleLive).toHaveBeenCalledTimes(1);
      expect(handleTest).not.toHaveBeenCalled();
      // The test endpoint still takes test events as before.
      expect((await send("/webhooks/stripe/vayada-payment", test, signed(test))).json()).toEqual({
        received: true,
        handled: true,
      });
      expect(handleTest).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("serves both endpoints from the app, each pinned to its own mode", async () => {
    const handle = vi.fn(async () => "handled" as const);
    const app = buildApp({
      logger: false,
      // The test endpoint stays test mode whatever its options say.
      vayadaPaymentWebhooks: { secret, livemode: true, handle, now: () => now },
      vayadaPaymentLiveWebhooks: { secret: "whsec_vay2442live", handle, now: () => now },
    });
    const send = (url: string, body: string, signature: string) =>
      app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: body,
      });
    try {
      const test = JSON.stringify(event);
      const live = JSON.stringify({ ...event, livemode: true });
      expect((await send("/webhooks/stripe/vayada-payment", test, signed(test))).json()).toEqual({
        received: true,
        handled: true,
      });
      expect((await send("/webhooks/stripe/vayada-payment", live, signed(live))).json()).toEqual({
        received: true,
        handled: false,
      });
      expect(
        (
          await send(
            "/webhooks/stripe/vayada-payment-live",
            live,
            signed(live, "whsec_vay2442live"),
          )
        ).json(),
      ).toEqual({ received: true, handled: true });
      expect(handle).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("lets Stripe retry when an event can't be applied yet", async () => {
    const { app } = await appWith(vi.fn(async () => Promise.reject(new Error("database down"))));
    try {
      const body = JSON.stringify(event);
      expect((await post(app, body, signed(body))).statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("converts Stripe's dispute fee into the stay's currency with the transaction's own rate", () => {
    // EUR 15.00 fee; 1 IDR = 0.0000575 EUR, so IDR 260,869.57 (minor units, two decimals).
    expect(stayCurrencyFee({ currency: "eur", exchange_rate: 0.0000575 }, 1500, "IDR")).toBe(
      26086957,
    );
    expect(stayCurrencyFee({ currency: "eur", exchange_rate: null }, 1500, "EUR")).toBe(1500);
    // JPY has no minor unit: EUR 15.00 at 1 JPY = 0.006 EUR is JPY 2,500.
    expect(stayCurrencyFee({ currency: "eur", exchange_rate: 0.006 }, 1500, "JPY")).toBe(2500);
    expect(stayCurrencyFee({ currency: "eur", exchange_rate: null }, 1500, "IDR")).toBeNull();
    expect(stayCurrencyFee({ currency: "eur" }, 0, "IDR")).toBe(0);
  });

  it("converts a dispute's fee at the rate of the dispute's own amounts when Stripe gives none", () => {
    // Test run C (2026-11-03): an IDR 500,000 dispute was withdrawn from Vayada's EUR account as
    // EUR -24.64 with Stripe's EUR 20.00 fee and no exchange rate. The fee is IDR 405,844.16.
    const withdrawal = { currency: "eur", exchange_rate: null, amount: -2464, fee: 2000 };
    expect(stayCurrencyFee(withdrawal, 2000, "IDR", 50_000_000)).toBe(40_584_416);
    // Won: Stripe kept its fee, so nothing comes back; a fee given back converts the same way.
    const reversal = { currency: "eur", exchange_rate: null, amount: 2464, fee: 0 };
    expect(stayCurrencyFee(reversal, 0, "IDR", 50_000_000)).toBe(0);
    expect(stayCurrencyFee(reversal, 2000, "IDR", 50_000_000)).toBe(40_584_416);
    // JPY has no minor unit: a JPY 2,500 dispute withdrawn as EUR -15.00 makes EUR 15.00 JPY 2,500.
    expect(stayCurrencyFee({ currency: "eur", amount: -1500 }, 1500, "JPY", 2500)).toBe(2500);
    // Stripe's own rate wins when it sends one.
    expect(
      stayCurrencyFee({ ...withdrawal, exchange_rate: 0.0000575 }, 1500, "IDR", 50_000_000),
    ).toBe(26086957);
    // Without both amounts the fee stays unknown (logged for a person, recorded as 0).
    expect(stayCurrencyFee(withdrawal, 2000, "IDR")).toBeNull();
    expect(stayCurrencyFee(withdrawal, 2000, "IDR", 0)).toBeNull();
    expect(stayCurrencyFee({ ...withdrawal, amount: 0 }, 2000, "IDR", 50_000_000)).toBeNull();
    // A dispute under one euro: EUR 0.99 is rounded too coarsely to price a EUR 20 fee.
    expect(stayCurrencyFee({ ...withdrawal, amount: -99 }, 2000, "IDR", 2_000_000)).toBeNull();
    expect(stayCurrencyFee({ ...withdrawal, amount: -100 }, 2000, "IDR", 2_000_000)).toBe(
      40_000_000,
    );
    expect(stayCurrencyFee({ ...withdrawal, amount: "-2464" }, 2000, "IDR", 50_000_000)).toBeNull();
  });

  it("takes the webhook secret only as a Stripe signing secret", () => {
    const keys = {
      VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_test_abc",
      VAYADA_PAYMENT_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
    };
    expect(loadConfig(keys).vayadaPaymentStripe).not.toHaveProperty("webhookSecret");
    expect(
      loadConfig({ ...keys, VAYADA_PAYMENT_STRIPE_WEBHOOK_SECRET: "whsec_abc" })
        .vayadaPaymentStripe,
    ).toMatchObject({ webhookSecret: "whsec_abc" });
    expect(() => loadConfig({ ...keys, VAYADA_PAYMENT_STRIPE_WEBHOOK_SECRET: "abc" })).toThrow(
      "signing secret",
    );
    expect(() => loadConfig({ VAYADA_PAYMENT_STRIPE_WEBHOOK_SECRET: "whsec_abc" })).toThrow(
      "test-mode keys",
    );
  });
});
