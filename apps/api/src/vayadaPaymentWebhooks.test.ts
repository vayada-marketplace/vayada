import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
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
