import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  executePricingCardRefund,
  runPendingPricingCardRefunds,
  stagePricingCardRefund,
} from "./pricingCardRefund.js";
import type { StripeBookingPaymentProvider, StripeBookingRefund } from "./stripeBookingPayments.js";

const url = process.env["TEST_DATABASE_URL"];

/** Stripe's refunds of one payment, kept in memory; `next` decides what the next one does. */
function fakeStripe() {
  const refunds: StripeBookingRefund[] = [];
  const state = { next: "succeeded" as string, loseResponse: false, failCreate: false };
  const provider = {
    createRefund: vi.fn(
      async (input: Parameters<StripeBookingPaymentProvider["createRefund"]>[0]) => {
        if (state.failCreate) throw new Error("Stripe is unavailable");
        const refund: StripeBookingRefund = {
          refundId: `re_${randomUUID().slice(0, 8)}`,
          status: state.next,
          amountMinor: input.amountMinor,
          currency: "EUR",
          paymentIntentId: input.paymentIntentId,
          commandId: input.commandId,
          failureReason: state.next === "failed" ? "expired_or_canceled_card" : null,
        };
        refunds.push(refund);
        if (state.loseResponse) throw new Error("socket hang up");
        return refund;
      },
    ),
    listRefunds: vi.fn(async () => [...refunds]),
    retrieveRefund: vi.fn(async (id: string) => refunds.find((r) => r.refundId === id)!),
  };
  return {
    refunds,
    state,
    provider: provider as unknown as StripeBookingPaymentProvider & typeof provider,
  };
}

describe.skipIf(!url)("pricing card refunds (VAY-2205)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  afterAll(() => pool.end());

  async function paidCardStay(amount = "100.00") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID(),
      guestBookingId = randomUUID(),
      accountId = randomUUID(),
      paymentId = randomUUID(),
      accountRef = `acct_${randomUUID().slice(0, 8)}`,
      intent = `pi_${randomUUID().slice(0, 8)}`;
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Refund test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,payment_status,
         check_in,check_out,currency)
       VALUES($1,$2,$3,'canceled','paid','2027-03-10','2027-03-12','EUR')`,
      [guestBookingId, propertyId, `R-${guestBookingId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status)
       VALUES($1,$2,'property','stripe',$3,'active')`,
      [accountId, propertyId, accountRef],
    );
    await pool.query(
      `INSERT INTO finance.payments(id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,
         status,amount,net_amount,currency,provider_payment_intent_id,visibility_class,paid_at)
       VALUES($1,$2,$3,$4,'full','card','paid',$5::numeric,$5::numeric,'EUR',$6,'pms_finance',now())`,
      [paymentId, propertyId, guestBookingId, accountId, amount, intent],
    );
    await pool.query(
      "UPDATE booking.guest_bookings SET active_card_payment_id=$1 WHERE id=$2 AND property_id=$3",
      [paymentId, guestBookingId, propertyId],
    );
    const stage = async (
      retainedMinor: string,
      commandKey = "cancel-1",
      requestedBy: "guest" | "host" = "guest",
    ) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const staged = await stagePricingCardRefund(client, {
          propertyId,
          guestBookingId,
          retainedMinor,
          requestedBy,
          commandKey,
          occurredAt: new Date(),
        });
        await client.query("COMMIT");
        return staged;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const state = async () => ({
      payment: (
        await pool.query(
          "SELECT status,refunded_amount::text AS refunded FROM finance.payments WHERE id=$1",
          [paymentId],
        )
      ).rows[0],
      refundRows: (
        await pool.query(
          `SELECT amount::text AS amount,net_amount::text AS net,status,provider_transaction_id AS "refundId",
             payment_metadata->>'correctsPaymentEvidenceId' AS corrects
           FROM finance.payments WHERE guest_booking_id=$1 AND payment_kind='refund'`,
          [guestBookingId],
        )
      ).rows,
      booking: (
        await pool.query("SELECT payment_status FROM booking.guest_bookings WHERE id=$1", [
          guestBookingId,
        ])
      ).rows[0].payment_status,
      commands: (
        await pool.query(
          `SELECT status,amount::text AS amount,amount_minor::text AS minor,attempts,provider_refund_id AS "refundId",
             failure_reason AS reason
           FROM finance.card_refund_commands WHERE guest_booking_id=$1 ORDER BY created_at`,
          [guestBookingId],
        )
      ).rows,
    });
    return { propertyId, guestBookingId, paymentId, accountRef, intent, stage, state };
  }

  it("records the refund the terms owe in the cancel transaction, once, and money moves only when Stripe succeeds", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    const staged = await f.stage("3000");
    expect(staged).toMatchObject({ amount: "70.00", currency: "EUR" });
    // A replay of the same command is the same refund; another command for the payment is refused.
    expect(await f.stage("3000")).toEqual(staged);
    await expect(f.stage("0", "cancel-2", "host")).rejects.toMatchObject({ code: "conflict" });
    // Pending is not money: the card payment and the booking are untouched.
    expect(await f.state()).toMatchObject({
      payment: { status: "paid", refunded: "0.00" },
      refundRows: [],
      booking: "paid",
      commands: [{ status: "pending", amount: "70.00", minor: "7000", attempts: 0 }],
    });
    expect(await executePricingCardRefund(pool, stripe.provider, staged!.commandId)).toBe(
      "succeeded",
    );
    expect(stripe.provider.createRefund).toHaveBeenCalledOnce();
    expect(stripe.provider.createRefund.mock.calls[0]![0]).toMatchObject({
      paymentIntentId: f.intent,
      providerAccountRef: f.accountRef,
      amountMinor: 7000,
      commandId: staged!.commandId,
      propertyId: f.propertyId,
    });
    const settled = await f.state();
    expect(settled).toMatchObject({
      payment: { status: "partially_refunded", refunded: "70.00" },
      refundRows: [{ amount: "70.00", net: "-70.00", status: "refunded", corrects: f.paymentId }],
      booking: "paid",
      commands: [{ status: "succeeded" }],
    });
    // Settled once: running it again neither asks Stripe nor records anything twice.
    expect(await executePricingCardRefund(pool, stripe.provider, staged!.commandId)).toBe(
      "succeeded",
    );
    expect(stripe.provider.createRefund).toHaveBeenCalledOnce();
    expect((await f.state()).refundRows).toHaveLength(1);
  });

  it("refunds everything when the terms keep nothing, and nothing when they keep it all", async () => {
    const all = await paidCardStay(),
      stripe = fakeStripe();
    await executePricingCardRefund(pool, stripe.provider, (await all.stage("0"))!.commandId);
    expect(await all.state()).toMatchObject({
      payment: { status: "refunded", refunded: "100.00" },
      booking: "refunded",
    });
    const none = await paidCardStay();
    expect(await none.stage("10000")).toBeNull();
    expect(await none.stage("12000", "cancel-more")).toBeNull();
    expect((await none.state()).commands).toEqual([]);
  });

  it("follows a refund that is pending at Stripe, and finds one whose answer was lost instead of asking twice", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    stripe.state.next = "pending";
    const { commandId } = (await f.stage("5000"))!;
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("pending");
    expect((await f.state()).commands).toMatchObject([{ status: "pending", attempts: 1 }]);
    stripe.refunds[0]!.status = "succeeded";
    await pool.query("UPDATE finance.card_refund_commands SET next_attempt_at=now() WHERE id=$1", [
      commandId,
    ]);
    expect(await runPendingPricingCardRefunds(pool, stripe.provider)).toMatchObject({ errors: 0 });
    expect(stripe.provider.retrieveRefund).toHaveBeenCalled();
    expect((await f.state()).payment).toMatchObject({ refunded: "50.00" });

    const lost = await paidCardStay(),
      lostStripe = fakeStripe();
    lostStripe.state.loseResponse = true;
    const lostCommand = (await lost.stage("0"))!.commandId;
    expect(await executePricingCardRefund(pool, lostStripe.provider, lostCommand)).toBe("pending");
    expect((await lost.state()).commands).toMatchObject([
      { status: "pending", attempts: 1, reason: "socket hang up" },
    ]);
    lostStripe.state.loseResponse = false;
    expect(await executePricingCardRefund(pool, lostStripe.provider, lostCommand)).toBe(
      "succeeded",
    );
    expect(lostStripe.provider.createRefund).toHaveBeenCalledOnce();
    expect((await lost.state()).payment).toMatchObject({ status: "refunded" });
  });

  it("marks a refund Stripe failed and leaves the payment alone", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    stripe.state.next = "failed";
    const { commandId } = (await f.stage("0"))!;
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("failed");
    expect(await f.state()).toMatchObject({
      payment: { status: "paid", refunded: "0.00" },
      refundRows: [],
      commands: [{ status: "failed", reason: "expired_or_canceled_card" }],
    });
  });

  it("asks Stripe once when the cancel and the sweep run the same refund together", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stripe.provider.listRefunds.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const { commandId } = (await f.stage("0"))!;
    const first = executePricingCardRefund(pool, stripe.provider, commandId);
    await vi.waitFor(() => expect(stripe.provider.listRefunds).toHaveBeenCalledOnce());
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("busy");
    release();
    expect(await first).toBe("succeeded");
    expect(stripe.provider.createRefund).toHaveBeenCalledOnce();
  });
});
