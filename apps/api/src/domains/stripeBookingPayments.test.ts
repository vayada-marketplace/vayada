import { describe, expect, it } from "vitest";

import { createStripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { STRIPE_REQUEST_TIMEOUT_MS } from "./stripeRequestTimeout.js";

/** A Stripe that never answers unless the request's own signal aborts it. */
function hangingFetch() {
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchImpl = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      signals.push(init?.signal);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  return { fetch: fetchImpl as typeof fetch, signals };
}

describe("Stripe booking payments", () => {
  it("creates a connected-account PaymentIntent with stable metadata", async () => {
    const calls: Array<{ url: string; body: string; key: string | null; account: string | null }> =
      [];
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          body: String(init?.body),
          key: headers.get("Idempotency-Key"),
          account: headers.get("Stripe-Account"),
        });
        return new Response(
          JSON.stringify({
            id: "pi_booking_1",
            client_secret: "pi_booking_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-001",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.createPaymentIntent({
        propertyId: "property-1",
        bookingReference: "B-001",
        providerAccountRef: "acct_1",
        amountMinor: 6050,
        applicationFeeAmountMinor: 303,
        currency: "EUR",
        captureMethod: "automatic",
        idempotencyKey: "booking-payment-1",
      }),
    ).resolves.toMatchObject({
      paymentIntentId: "pi_booking_1",
      amountMinor: 6050,
      currency: "EUR",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.stripe.com/v1/payment_intents",
      key: "booking-payment-1",
      account: "acct_1",
    });
    expect(new URLSearchParams(calls[0]!.body).has("transfer_data[destination]")).toBe(false);
    expect(new URLSearchParams(calls[0]!.body).get("payment_method_types[0]")).toBe("card");
    expect(new URLSearchParams(calls[0]!.body).get("capture_method")).toBe("automatic");
    expect(new URLSearchParams(calls[0]!.body).get("application_fee_amount")).toBe("303");
    expect(new URLSearchParams(calls[0]!.body).has("automatic_payment_methods[enabled]")).toBe(
      false,
    );

    await provider.capturePaymentIntent("pi_booking_1", "acct_1", "capture-booking-payment-1");
    expect(calls[1]).toMatchObject({
      url: "https://api.stripe.com/v1/payment_intents/pi_booking_1/capture",
      key: "capture-booking-payment-1",
      account: "acct_1",
    });
  });

  it("rejects a provider replay bound to another property", async () => {
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "pi_wrong_property",
            client_secret: "pi_wrong_property_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-2",
              vayada_booking_reference: "B-001",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      provider.createPaymentIntent({
        propertyId: "property-1",
        bookingReference: "B-001",
        providerAccountRef: "acct_1",
        amountMinor: 6050,
        applicationFeeAmountMinor: 303,
        currency: "EUR",
        captureMethod: "automatic",
        idempotencyKey: "booking-payment-1",
      }),
    ).rejects.toThrow("different property booking");
  });

  it("retrieves safe card display details from the PaymentIntent", async () => {
    let requestedUrl = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            id: "pi_booking_1",
            client_secret: "pi_booking_1_secret_test",
            status: "succeeded",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-001",
            },
            latest_charge: {
              id: "ch_booking_1",
              balance_transaction: {
                id: "txn_booking_1",
                amount: 6050,
                fee: 478,
                net: 5572,
                currency: "eur",
                fee_details: [
                  { type: "stripe_fee", amount: 175, currency: "eur" },
                  { type: "application_fee", amount: 303, currency: "eur" },
                ],
              },
            },
            payment_method: { card: { brand: "visa", last4: "4242" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(provider.retrievePaymentIntent("pi_booking_1", "acct_1")).resolves.toMatchObject({
      cardBrand: "visa",
      cardLast4: "4242",
      providerAccountRef: "acct_1",
      feeBreakdown: {
        processorFeeAmountMinor: 175,
        applicationFeeAmountMinor: 303,
        netPayoutAmountMinor: 5572,
      },
    });
    expect(new URL(requestedUrl).searchParams.get("expand[]")).toBe("payment_method");
  });

  it("creates request-mode PaymentIntents with manual capture", async () => {
    let body = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            id: "pi_request_1",
            client_secret: "pi_request_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-REQUEST-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await provider.createPaymentIntent({
      propertyId: "property-1",
      bookingReference: "B-REQUEST-1",
      providerAccountRef: "acct_1",
      amountMinor: 6050,
      applicationFeeAmountMinor: 303,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "booking-request-payment-1",
    });

    expect(new URLSearchParams(body).get("capture_method")).toBe("manual");
  });

  it("omits Vayada commission from fixed-plan direct charges", async () => {
    let body = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            id: "pi_fixed_1",
            client_secret: "pi_fixed_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-FIXED-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await provider.createPaymentIntent({
      propertyId: "property-1",
      bookingReference: "B-FIXED-1",
      providerAccountRef: "acct_1",
      amountMinor: 6050,
      applicationFeeAmountMinor: 0,
      currency: "EUR",
      captureMethod: "automatic",
      idempotencyKey: "booking-fixed-payment-1",
    });

    expect(new URLSearchParams(body).has("application_fee_amount")).toBe(false);
  });

  describe("request timeouts (VAY-2297)", () => {
    it("gives up on a Stripe call that hangs, within the request timeout", async () => {
      const hung = hangingFetch();
      const provider = createStripeBookingPaymentProvider({
        secretKey: "sk_test",
        fetch: hung.fetch,
        timeoutMs: 20,
      });

      await expect(
        provider.createPaymentIntent({
          propertyId: "property-1",
          bookingReference: "B-001",
          providerAccountRef: "acct_1",
          amountMinor: 6050,
          applicationFeeAmountMinor: 303,
          currency: "EUR",
          captureMethod: "automatic",
          idempotencyKey: "intent-1",
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      await expect(provider.retrievePaymentIntent("pi_1", "acct_1")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(hung.signals).toHaveLength(2);
      expect(hung.signals.every((signal) => signal?.aborted)).toBe(true);
    });

    it("caps every call at 30 s with the request's own signal", async () => {
      const signals: (AbortSignal | null | undefined)[] = [];
      const provider = createStripeBookingPaymentProvider({
        secretKey: "sk_test",
        fetch: async (_input, init) => {
          signals.push(init?.signal);
          return new Response(
            JSON.stringify({
              id: "pi_1",
              status: "requires_capture",
              amount: 100,
              currency: "eur",
              metadata: {},
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });

      await provider.retrievePaymentIntent("pi_1", "acct_1");
      await provider.capturePaymentIntent("pi_1", "acct_1", "capture-1");
      await provider.cancelPaymentIntent("pi_1", "acct_1", "cancel-1");

      expect(STRIPE_REQUEST_TIMEOUT_MS).toBe(30_000);
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(
        true,
      );
    });
  });

  describe("refunds (VAY-2205)", () => {
    const stripeRefund = (extra: Record<string, unknown> = {}) => ({
      id: "re_1",
      status: "pending",
      amount: 4000,
      currency: "eur",
      payment_intent: "pi_booking_1",
      metadata: { vayada_refund_command_id: "command-1" },
      ...extra,
    });
    const recording = (payload: unknown) => {
      const calls: Array<{
        method: string;
        url: string;
        body: string;
        key: string | null;
        account: string | null;
      }> = [];
      const provider = createStripeBookingPaymentProvider({
        secretKey: "sk_test",
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          calls.push({
            method: String(init?.method),
            url: String(input),
            body: String(init?.body ?? ""),
            key: headers.get("Idempotency-Key"),
            account: headers.get("Stripe-Account"),
          });
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      return { calls, provider };
    };
    const input = {
      paymentIntentId: "pi_booking_1",
      providerAccountRef: "acct_1",
      amountMinor: 4000,
      refundApplicationFee: true,
      commandId: "command-1",
      propertyId: "property-1",
      bookingReference: "B-001",
      idempotencyKey: "refund-command-1",
    };

    it("refunds on the hotel's account, marked for the legacy webhook, with Vayada's fee in proportion", async () => {
      const { calls, provider } = recording(stripeRefund({ failure_reason: null }));
      await expect(provider.createRefund(input)).resolves.toEqual({
        refundId: "re_1",
        status: "pending",
        amountMinor: 4000,
        currency: "EUR",
        paymentIntentId: "pi_booking_1",
        commandId: "command-1",
        failureReason: null,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "POST",
        url: "https://api.stripe.com/v1/refunds",
        key: "refund-command-1",
        account: "acct_1",
      });
      expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
        payment_intent: "pi_booking_1",
        amount: "4000",
        refund_application_fee: "true",
        reason: "requested_by_customer",
        "metadata[vayada_source]": "pricing_v2",
        "metadata[vayada_refund_command_id]": "command-1",
        "metadata[vayada_property_id]": "property-1",
        "metadata[vayada_booking_reference]": "B-001",
      });
    });

    it("asks for no fee refund on a charge without Vayada's fee, which Stripe would refuse", async () => {
      const { calls, provider } = recording(stripeRefund({ failure_reason: null }));
      await provider.createRefund({ ...input, refundApplicationFee: false });
      const body = Object.fromEntries(new URLSearchParams(calls[0]!.body));
      expect(body).not.toHaveProperty("refund_application_fee");
      expect(body).toMatchObject({ payment_intent: "pi_booking_1", amount: "4000" });
    });

    it("refuses a replay that answers for another command, payment or amount", async () => {
      for (const extra of [
        { metadata: { vayada_refund_command_id: "command-2" } },
        { payment_intent: "pi_other" },
        { amount: 3999 },
      ])
        await expect(recording(stripeRefund(extra)).provider.createRefund(input)).rejects.toThrow(
          "different command",
        );
      await expect(
        recording(stripeRefund()).provider.createRefund({ ...input, amountMinor: 0 }),
      ).rejects.toThrow("positive amount");
    });

    it("gives the HTTP status with Stripe's error, so a refusal is told from a lost answer", async () => {
      for (const status of [400, 429, 500]) {
        const provider = createStripeBookingPaymentProvider({
          secretKey: "sk_test",
          fetch: async () =>
            new Response(JSON.stringify({ error: { message: "No." } }), {
              status,
              headers: { "content-type": "application/json" },
            }),
        });
        await expect(provider.createRefund(input)).rejects.toMatchObject({
          message: "No.",
          statusCode: status,
        });
      }
    });

    it("gives up on a refund call after 30 seconds, so a row lock isn't held forever", async () => {
      const signals: Array<AbortSignal | null | undefined> = [];
      const provider = createStripeBookingPaymentProvider({
        secretKey: "sk_test",
        fetch: async (_input, init) => {
          signals.push(init?.signal);
          return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
        },
      });
      await provider.listRefunds("pi_booking_1", "acct_1");
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it("lists a payment's refunds and reads one, on the hotel's account", async () => {
      const list = recording({ data: [stripeRefund({ status: "succeeded" })], has_more: false });
      expect(await list.provider.listRefunds("pi_booking_1", "acct_1")).toMatchObject([
        { refundId: "re_1", status: "succeeded", commandId: "command-1" },
      ]);
      expect(list.calls[0]).toMatchObject({
        method: "GET",
        url: "https://api.stripe.com/v1/refunds?payment_intent=pi_booking_1&limit=100",
        account: "acct_1",
      });
      await expect(
        recording({ data: [], has_more: true }).provider.listRefunds("pi_booking_1", "acct_1"),
      ).rejects.toThrow("incomplete");
      const one = recording(
        stripeRefund({ status: "failed", failure_reason: "expired_or_canceled_card" }),
      );
      expect(await one.provider.retrieveRefund("re_1", "acct_1")).toMatchObject({
        status: "failed",
        failureReason: "expired_or_canceled_card",
      });
      expect(one.calls[0]!.url).toBe("https://api.stripe.com/v1/refunds/re_1");
    });
  });
});
