import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createPricingCardReconciliationAlert,
  reconcilePricingCardPayments,
} from "./pricingCardReconciliation.js";
import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "./stripeBookingPayments.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("pricing card reconciliation (VAY-2205)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(() => pool.end());

  /** A paid pricing-v2 card stay of 100.00 EUR on its own hotel. */
  async function stay(refunded = "0.00", status = "paid") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID(),
      bookingId = randomUUID(),
      accountId = randomUUID(),
      paymentId = randomUUID(),
      intent = `pi_${randomUUID().slice(0, 8)}`;
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Check')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out,
         currency,booking_metadata)
       VALUES($1,$2,$3,'confirmed','paid','2027-03-10','2027-03-12','EUR','{"targetSource":"pricing_quote_draft","paymentMethod":"card"}')`,
      [bookingId, propertyId, `C-${bookingId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status)
       VALUES($1,$2,'property','stripe',$3,'active')`,
      [accountId, propertyId, `acct_${randomUUID().slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO finance.payments(id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,status,
         amount,net_amount,refunded_amount,currency,provider_payment_intent_id,visibility_class,paid_at,payment_metadata)
       VALUES($1,$2,$3,$4,'full','card',$7,100,100,$6::numeric,'EUR',$5,'pms_finance',now(),'{"chargeType":"direct"}')`,
      [paymentId, propertyId, bookingId, accountId, intent, refunded, status],
    );
    return { propertyId, bookingId, paymentId, intent };
  }
  async function refundCommand(
    s: Awaited<ReturnType<typeof stay>>,
    status: "pending" | "succeeded" | "failed",
    createdAt = "now()",
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO finance.card_refund_commands(id,property_id,guest_booking_id,payment_id,idempotency_key,requested_by,amount,
         amount_minor,currency,provider_account_ref,provider_payment_intent_id,status,provider_refund_id,failure_reason,
         created_at,settled_at)
       VALUES($1,$2,$3,$4,$5,'guest',40,4000,'EUR','acct_check',$6,$7,$8,$9,${createdAt},
         CASE WHEN $7='pending' THEN NULL ELSE now() END)`,
      [
        id,
        s.propertyId,
        s.bookingId,
        s.paymentId,
        `check:${id}`,
        s.intent,
        status,
        status === "pending" ? null : `re_${id.slice(0, 8)}`,
        status === "failed" ? "expired_or_canceled_card" : null,
      ],
    );
    return { id, refundId: `re_${id.slice(0, 8)}` };
  }

  it("lists every difference with Stripe for the hotel to check, and nothing when they agree", async () => {
    const agree = await stay(),
      canceledAtStripe = await stay(),
      refundedAtStripe = await stay(),
      disputed = await stay(),
      unreachable = await stay();
    const failedLater = await stay("40.00", "partially_refunded"),
      stuck = await stay(),
      failed = await stay();
    const later = await refundCommand(failedLater, "succeeded");
    await refundCommand(stuck, "pending", "now()-interval '2 days'");
    await refundCommand(failed, "failed");
    // A failure the hotel retried successfully is no longer a difference.
    const retried = await stay("40.00", "partially_refunded");
    await refundCommand(retried, "failed", "now()-interval '1 hour'");
    await refundCommand(retried, "succeeded");
    const intent = (id: string, extra: Partial<StripeBookingPaymentIntent> = {}) =>
      ({
        paymentIntentId: id,
        clientSecret: null,
        status: "succeeded",
        amountMinor: 10000,
        currency: "EUR",
        propertyId: null,
        bookingReference: null,
        providerAccountRef: null,
        amountRefundedMinor: 0,
        disputed: false,
        ...extra,
      }) as StripeBookingPaymentIntent;
    const special: Record<string, Partial<StripeBookingPaymentIntent>> = {
      [canceledAtStripe.intent]: { status: "canceled" },
      [refundedAtStripe.intent]: { amountRefundedMinor: 2500 },
      [disputed.intent]: { disputed: true },
      [failedLater.intent]: { amountRefundedMinor: 4000 },
      [retried.intent]: { amountRefundedMinor: 4000 },
    };
    const provider = {
      retrievePaymentIntent: vi.fn(async (id: string) => {
        if (id === unreachable.intent) throw new Error("Stripe timed out");
        return intent(id, special[id]);
      }),
      retrieveRefund: vi.fn(async (refundId: string) => ({
        refundId,
        status: refundId === later.refundId ? "failed" : "succeeded",
        amountMinor: 4000,
        currency: "EUR",
        paymentIntentId: "pi_any",
        commandId: null,
        failureReason: refundId === later.refundId ? "lost_or_stolen_card" : null,
      })),
    } as unknown as StripeBookingPaymentProvider;

    const { mismatches } = await reconcilePricingCardPayments(pool, provider);
    const mine = (s: { propertyId: string }) =>
      mismatches.filter((m) => m.propertyId === s.propertyId).map((m) => m.kind);
    expect(mine(agree)).toEqual([]);
    expect(mine(canceledAtStripe)).toEqual(["payment_status"]);
    expect(mine(refundedAtStripe)).toEqual(["refunded_at_stripe"]);
    expect(mine(disputed)).toEqual(["disputed"]);
    expect(mine(unreachable)).toEqual(["stripe_unreachable"]);
    expect(mine(failedLater)).toEqual(["refund_failed_later"]);
    // A refund under way is expected to differ at Stripe; one pending for over a day is reported.
    expect(mine(stuck)).toEqual(["refund_stuck"]);
    expect(mine(failed)).toEqual(["refund_failed"]);
    expect(mine(retried)).toEqual([]);
    expect(mismatches.find((m) => m.propertyId === failedLater.propertyId)?.detail).toContain(
      "lost_or_stolen_card",
    );
  });

  it("emails the differences once a day, ids only", async () => {
    const send = vi.fn(async () => undefined);
    const alert = createPricingCardReconciliationAlert({
      to: "ops@example.test",
      delivery: { send },
    });
    expect(await alert([])).toBe(false);
    const mismatch = {
      kind: "disputed" as const,
      propertyId: "p",
      guestBookingId: "b",
      reference: "pay",
      detail: "The guest disputed the card payment.",
    };
    expect(await alert([mismatch], new Date("2027-01-02T08:00:00Z"))).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@example.test",
        subject: "Vayada: 1 card payment difference(s) with Stripe",
        text: expect.stringContaining("- disputed: property p, booking b, pay"),
        idempotencyKey: expect.stringMatching(/^pricing-card-reconciliation:2027-01-02:/),
      }),
    );
  });
});
