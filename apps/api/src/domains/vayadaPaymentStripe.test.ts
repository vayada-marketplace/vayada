import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import {
  isVayadaPaymentAccountRef,
  routeVayadaPaymentStripe,
  stripeCallAccountRef,
} from "./vayadaPaymentStripe.js";

const ref = "vayada:24420000-0000-4000-8000-000000000001";

function fakeProvider(name: string) {
  const intent = (providerAccountRef: string | null) => ({
    paymentIntentId: `pi_${name}`,
    clientSecret: `pi_${name}_secret_1`,
    status: "requires_payment_method",
    amountMinor: 1000,
    currency: "IDR",
    propertyId: null,
    bookingReference: null,
    providerAccountRef,
  });
  const refund = { refundId: `re_${name}`, status: "pending", amountMinor: 1, currency: "IDR" };
  return {
    createPaymentIntent: vi.fn(async (input: { providerAccountRef: string | null }) =>
      intent(input.providerAccountRef),
    ),
    retrievePaymentIntent: vi.fn(async (_id: string, account: string | null) => intent(account)),
    capturePaymentIntent: vi.fn(async (_id: string, account: string | null) => intent(account)),
    cancelPaymentIntent: vi.fn(async (_id: string, account: string | null) => intent(account)),
    createRefund: vi.fn(async () => refund),
    listRefunds: vi.fn(async () => [refund]),
    retrieveRefund: vi.fn(async () => refund),
  };
}

const charge = (providerAccountRef: string, applicationFeeAmountMinor = 0) => ({
  propertyId: "24420000-0000-4000-8000-000000000001",
  bookingReference: "VAY-ABC123",
  providerAccountRef,
  amountMinor: 1000,
  applicationFeeAmountMinor,
  currency: "IDR",
  captureMethod: "automatic" as const,
  idempotencyKey: "key",
});

describe("vayada Payment's Stripe routing (VAY-2442)", () => {
  it("charges vayada:<property> payments on Vayada's own account, without a connected account or fee", async () => {
    const connect = fakeProvider("connect");
    const own = fakeProvider("vayada");
    const provider = routeVayadaPaymentStripe(connect as never, {
      provider: own as unknown as StripeBookingPaymentProvider,
      publishableKey: "pk_test_vayada",
    });

    const intent = await provider.createPaymentIntent(charge(ref));
    expect(own.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountRef: null, applicationFeeAmountMinor: 0 }),
    );
    expect(intent).toMatchObject({
      paymentIntentId: "pi_vayada",
      providerAccountRef: ref,
      publishableKey: "pk_test_vayada",
    });
    await expect(provider.createPaymentIntent(charge(ref, 50))).rejects.toThrow(
      "carries no application fee",
    );
    for (const call of [
      () => provider.retrievePaymentIntent("pi_vayada", ref),
      () => provider.capturePaymentIntent("pi_vayada", ref, "k"),
      () => provider.cancelPaymentIntent("pi_vayada", ref, "k"),
    ])
      await expect(call()).resolves.toMatchObject({ providerAccountRef: ref });
    expect(own.retrievePaymentIntent).toHaveBeenCalledWith("pi_vayada", null);
    expect(own.capturePaymentIntent).toHaveBeenCalledWith("pi_vayada", null, "k");
    expect(own.cancelPaymentIntent).toHaveBeenCalledWith("pi_vayada", null, "k");

    // There is no application fee to give back on Vayada's own charge.
    await provider.createRefund({
      paymentIntentId: "pi_vayada",
      providerAccountRef: ref,
      amountMinor: 1,
      refundApplicationFee: true,
      commandId: "c",
      propertyId: "p",
      bookingReference: "VAY-ABC123",
      idempotencyKey: "k",
    });
    expect(own.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountRef: null, refundApplicationFee: false }),
    );
    await provider.listRefunds("pi_vayada", ref);
    await provider.retrieveRefund("re_vayada", ref);
    expect(own.listRefunds).toHaveBeenCalledWith("pi_vayada", null);
    expect(own.retrieveRefund).toHaveBeenCalledWith("re_vayada", null);
    for (const fn of Object.values(connect)) expect(fn).not.toHaveBeenCalled();
  });

  it("leaves Stripe Connect payments exactly as they were", async () => {
    const connect = fakeProvider("connect");
    const own = fakeProvider("vayada");
    const provider = routeVayadaPaymentStripe(connect as never, {
      provider: own as never,
      publishableKey: "pk_test_vayada",
    });
    const intent = await provider.createPaymentIntent(charge("acct_hotel", 50));
    expect(connect.createPaymentIntent).toHaveBeenCalledWith(charge("acct_hotel", 50));
    expect(intent).not.toHaveProperty("publishableKey");
    await provider.retrievePaymentIntent("pi_connect", "acct_hotel");
    expect(connect.retrievePaymentIntent).toHaveBeenCalledWith("pi_connect", "acct_hotel");
    for (const fn of Object.values(own)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses vayada Payment charges when its Stripe account isn't configured", async () => {
    const provider = routeVayadaPaymentStripe(fakeProvider("connect") as never, undefined);
    await expect(provider.createPaymentIntent(charge(ref))).rejects.toThrow("not configured");
    await expect(provider.retrievePaymentIntent("pi_x", ref)).rejects.toThrow("not configured");
    expect(isVayadaPaymentAccountRef(ref)).toBe(true);
    expect(isVayadaPaymentAccountRef("acct_hotel")).toBe(false);
    expect(isVayadaPaymentAccountRef(null)).toBe(false);
  });

  it("calls a live hotel's payments only with the live keys and every other hotel's with the test keys", async () => {
    const liveRef = "vayada:24420000-0000-4000-8000-0000000000aa";
    const connect = fakeProvider("connect");
    const test = fakeProvider("test");
    const live = fakeProvider("live");
    const provider = routeVayadaPaymentStripe(
      connect as never,
      { provider: test as never, publishableKey: "pk_test_vayada" },
      {
        account: { provider: live as never, publishableKey: "pk_live_vayada" },
        for: (propertyId) => propertyId === "24420000-0000-4000-8000-0000000000aa",
      },
    );

    await expect(provider.createPaymentIntent(charge(liveRef))).resolves.toMatchObject({
      paymentIntentId: "pi_live",
      providerAccountRef: liveRef,
      publishableKey: "pk_live_vayada",
    });
    await expect(provider.createPaymentIntent(charge(ref))).resolves.toMatchObject({
      paymentIntentId: "pi_test",
      providerAccountRef: ref,
      publishableKey: "pk_test_vayada",
    });
    await provider.retrievePaymentIntent("pi_live", liveRef);
    await provider.capturePaymentIntent("pi_live", liveRef, "k");
    await provider.cancelPaymentIntent("pi_live", liveRef, "k");
    await provider.createRefund({
      paymentIntentId: "pi_live",
      providerAccountRef: liveRef,
      amountMinor: 1,
      refundApplicationFee: true,
      commandId: "c",
      propertyId: "p",
      bookingReference: "VAY-ABC123",
      idempotencyKey: "k",
    });
    await provider.listRefunds("pi_live", liveRef);
    await provider.retrieveRefund("re_live", liveRef);
    for (const fn of [
      live.retrievePaymentIntent,
      live.capturePaymentIntent,
      live.cancelPaymentIntent,
      live.createRefund,
      live.listRefunds,
      live.retrieveRefund,
    ])
      expect(fn).toHaveBeenCalledTimes(1);
    expect(live.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountRef: null, refundApplicationFee: false }),
    );
    // Only the test hotel's charge went to the test keys; Connect saw nothing.
    expect(test.createPaymentIntent).toHaveBeenCalledTimes(1);
    for (const fn of [test.retrievePaymentIntent, test.createRefund, test.listRefunds])
      expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(connect)) expect(fn).not.toHaveBeenCalled();
  });

  it("never takes a live hotel's payment on the test keys, nor test money as real", async () => {
    const liveRef = "vayada:24420000-0000-4000-8000-0000000000aa";
    const isLive = (propertyId: string) => propertyId === "24420000-0000-4000-8000-0000000000aa";
    const test = fakeProvider("test");
    // Live keys not configured: the live hotel's calls fail instead of going to the test keys.
    const noLive = routeVayadaPaymentStripe(
      fakeProvider("connect") as never,
      { provider: test as never, publishableKey: "pk_test_vayada" },
      { for: isLive },
    );
    await expect(noLive.createPaymentIntent(charge(liveRef))).rejects.toThrow(
      "live-mode Stripe account is not configured",
    );
    await expect(noLive.retrievePaymentIntent("pi_x", liveRef)).rejects.toThrow(
      "live-mode Stripe account is not configured",
    );
    expect(test.createPaymentIntent).not.toHaveBeenCalled();
    expect(test.retrievePaymentIntent).not.toHaveBeenCalled();
    // Stripe's own livemode must match the hotel's before a guest can pay, and on every read.
    const modeOf = (livemode: boolean) => {
      const fake = fakeProvider(livemode ? "live" : "test");
      const withMode = async (account: string | null) => ({
        ...(await fakeProvider("x").retrievePaymentIntent("pi_x", account)),
        livemode,
      });
      fake.createPaymentIntent.mockImplementation(async (input) =>
        withMode(input.providerAccountRef),
      );
      fake.retrievePaymentIntent.mockImplementation(async (_id, account) => withMode(account));
      return fake;
    };
    const crossed = routeVayadaPaymentStripe(
      fakeProvider("connect") as never,
      { provider: modeOf(true) as never, publishableKey: "pk_test_vayada" },
      {
        account: { provider: modeOf(false) as never, publishableKey: "pk_live_vayada" },
        for: isLive,
      },
    );
    for (const call of [
      () => crossed.createPaymentIntent(charge(liveRef)),
      () => crossed.createPaymentIntent(charge(ref)),
      () => crossed.retrievePaymentIntent("pi_x", liveRef),
      () => crossed.retrievePaymentIntent("pi_x", ref),
    ])
      await expect(call()).rejects.toThrow("Stripe's mode does not match the hotel's");
    const matched = routeVayadaPaymentStripe(
      fakeProvider("connect") as never,
      { provider: modeOf(false) as never, publishableKey: "pk_test_vayada" },
      {
        account: { provider: modeOf(true) as never, publishableKey: "pk_live_vayada" },
        for: isLive,
      },
    );
    await expect(matched.createPaymentIntent(charge(liveRef))).resolves.toMatchObject({
      livemode: true,
      publishableKey: "pk_live_vayada",
    });
    await expect(matched.retrievePaymentIntent("pi_x", ref)).resolves.toMatchObject({
      livemode: false,
      publishableKey: "pk_test_vayada",
    });
  });

  it("reads a stored payment's own account for vayada Payment too, not the platform's", () => {
    // Host decline, the request deadline sweep and the guest's booking lookup call Stripe with it.
    expect(stripeCallAccountRef("vayada_payment", ref)).toBe(ref);
    expect(stripeCallAccountRef("direct", "acct_hotel")).toBe("acct_hotel");
    expect(stripeCallAccountRef("destination", "acct_hotel")).toBeNull();
    expect(stripeCallAccountRef(undefined, "acct_hotel")).toBeNull();
    expect(stripeCallAccountRef("direct", null)).toBeNull();
  });

  it("accepts test-mode keys in the test set, live-mode keys in the live set and a fee from 0 to 50 percent", () => {
    expect(loadConfig({}).vayadaPaymentStripe).toBeUndefined();
    expect(loadConfig({}).vayadaPaymentFeePercent).toBe(6);
    expect(
      loadConfig({
        VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_test_abc",
        VAYADA_PAYMENT_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
        VAYADA_PAYMENT_FEE_PERCENT: "4.5",
      }),
    ).toMatchObject({
      vayadaPaymentStripe: { secretKey: "sk_test_abc", publishableKey: "pk_test_abc" },
      vayadaPaymentFeePercent: 4.5,
    });
    for (const env of [
      {
        VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_live_abc",
        VAYADA_PAYMENT_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
      },
      {
        VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_test_abc",
        VAYADA_PAYMENT_STRIPE_PUBLISHABLE_KEY: "pk_live_abc",
      },
      { VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_test_abc" },
    ])
      expect(() => loadConfig(env)).toThrow("must both be Stripe test-mode keys");
    // The live set takes live keys only, so test money and real money never mix.
    expect(loadConfig({}).vayadaPaymentStripeLive).toBeUndefined();
    expect(
      loadConfig({
        VAYADA_PAYMENT_STRIPE_LIVE_SECRET_KEY: "rk_live_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_PUBLISHABLE_KEY: "pk_live_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live",
      }).vayadaPaymentStripeLive,
    ).toEqual({
      secretKey: "rk_live_abc",
      publishableKey: "pk_live_abc",
      webhookSecret: "whsec_live",
    });
    for (const env of [
      {
        VAYADA_PAYMENT_STRIPE_LIVE_SECRET_KEY: "sk_test_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_PUBLISHABLE_KEY: "pk_test_abc",
      },
      {
        VAYADA_PAYMENT_STRIPE_LIVE_SECRET_KEY: "sk_live_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_PUBLISHABLE_KEY: "pk_test_abc",
      },
      { VAYADA_PAYMENT_STRIPE_LIVE_PUBLISHABLE_KEY: "pk_live_abc" },
    ])
      expect(() => loadConfig(env)).toThrow("must both be Stripe live-mode keys");
    expect(() =>
      loadConfig({
        VAYADA_PAYMENT_STRIPE_LIVE_SECRET_KEY: "sk_live_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_PUBLISHABLE_KEY: "pk_live_abc",
        VAYADA_PAYMENT_STRIPE_LIVE_WEBHOOK_SECRET: "live",
      }),
    ).toThrow("VAYADA_PAYMENT_STRIPE_LIVE_WEBHOOK_SECRET must be a Stripe webhook signing secret");
    for (const fee of ["51", "-1", "six", "6.125"])
      expect(() => loadConfig({ VAYADA_PAYMENT_FEE_PERCENT: fee })).toThrow(
        "VAYADA_PAYMENT_FEE_PERCENT",
      );
  });
});
