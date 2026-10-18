import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  executePricingCardRefund,
  MAX_ATTEMPTS,
  retryPricingCardRefund,
  runPendingPricingCardRefunds,
  stagePricingCardRefund,
} from "./pricingCardRefund.js";
import type { StripeBookingPaymentProvider, StripeBookingRefund } from "./stripeBookingPayments.js";

const url = process.env["TEST_DATABASE_URL"];

/** Stripe's refunds of one payment, kept in memory; `next` decides what the next one does. */
function fakeStripe() {
  const refunds: StripeBookingRefund[] = [];
  const state = {
    next: "succeeded" as string,
    loseResponse: false,
    failCreate: false,
    /** Stripe answers the create with a definite refusal (a 4xx). */
    refuseCreate: false,
    failList: false,
  };
  const provider = {
    createRefund: vi.fn(
      async (input: Parameters<StripeBookingPaymentProvider["createRefund"]>[0]) => {
        if (state.failCreate) throw new Error("Stripe is unavailable");
        if (state.refuseCreate)
          throw Object.assign(new Error("This charge can't be refunded."), { statusCode: 400 });
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
    listRefunds: vi.fn(async () => {
      if (state.failList) throw new Error("Stripe list is unavailable");
      return [...refunds];
    }),
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
         check_in,check_out,currency,booking_metadata)
       VALUES($1,$2,$3,'canceled','paid','2027-03-10','2027-03-12','EUR',
         '{"targetSource":"pricing_quote_draft","paymentMethod":"card"}')`,
      [guestBookingId, propertyId, `R-${guestBookingId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO booking.direct_booking_summary_read_model
         (guest_booking_id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out)
       SELECT id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out
       FROM booking.guest_bookings WHERE id=$1`,
      [guestBookingId],
    );
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status)
       VALUES($1,$2,'property','stripe',$3,'active')`,
      [accountId, propertyId, accountRef],
    );
    await pool.query(
      `INSERT INTO finance.payments(id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,
         status,amount,net_amount,currency,provider_payment_intent_id,visibility_class,paid_at,payment_metadata)
       VALUES($1,$2,$3,$4,'full','card','paid',$5::numeric,$5::numeric,'EUR',$6,'pms_finance',now(),
         '{"chargeType":"direct"}')`,
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
    expect(
      (
        await pool.query(
          "SELECT payment_status FROM booking.direct_booking_summary_read_model WHERE guest_booking_id=$1",
          [all.guestBookingId],
        )
      ).rows,
    ).toEqual([{ payment_status: "refunded" }]);
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

  it("retries a Stripe error with a fresh key, and gives up only on a refund Stripe refused and never made", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    stripe.state.failCreate = true;
    const { commandId } = (await f.stage("0"))!;
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("pending");
    stripe.state.failCreate = false;
    await pool.query("UPDATE finance.card_refund_commands SET next_attempt_at=now() WHERE id=$1", [
      commandId,
    ]);
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("succeeded");
    const keys = stripe.provider.createRefund.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[1]).toBe(`${keys[0]}:attempt-1`);

    const lost = await paidCardStay(),
      lostStripe = fakeStripe();
    const lostId = (await lost.stage("0"))!.commandId;
    await pool.query("UPDATE finance.card_refund_commands SET attempts=$2 WHERE id=$1", [
      lostId,
      MAX_ATTEMPTS - 1,
    ]);
    // Stripe can't even list: nothing is confirmed, so it stays pending.
    lostStripe.state.failList = true;
    expect(await executePricingCardRefund(pool, lostStripe.provider, lostId)).toBe("pending");
    // Stripe lists no refund but the create's answer is lost: it may have made one, so no give-up.
    lostStripe.state.failList = false;
    lostStripe.state.failCreate = true;
    expect(await executePricingCardRefund(pool, lostStripe.provider, lostId)).toBe("pending");
    // Stripe lists no refund and refuses to make one: given up, with an audit event.
    lostStripe.state.failCreate = false;
    lostStripe.state.refuseCreate = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await executePricingCardRefund(pool, lostStripe.provider, lostId)).toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("must refund the guest"),
      expect.objectContaining({ commandId: lostId }),
    );
    warn.mockRestore();
    expect((await lost.state()).commands).toMatchObject([
      { status: "failed", reason: "This charge can't be refunded." },
    ]);
    expect(
      (
        await pool.query("SELECT action FROM platform.product_audit_events WHERE property_id=$1", [
          lost.propertyId,
        ])
      ).rows,
    ).toEqual([{ action: "finance.card_refund_failed" }]);
  });

  it("keeps a refund Stripe made but that couldn't be recorded, for a later retry", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    const { commandId } = (await f.stage("3000"))!;
    // The payment no longer has room for the refund, so recording it fails.
    await pool.query("UPDATE finance.payments SET refunded_amount=90 WHERE id=$1", [f.paymentId]);
    await expect(executePricingCardRefund(pool, stripe.provider, commandId)).rejects.toThrow(
      "couldn't be recorded",
    );
    const [command] = (await f.state()).commands;
    expect(command).toMatchObject({
      status: "pending",
      attempts: 1,
      refundId: stripe.refunds[0]!.refundId,
    });
    expect(command.reason).toContain("settlement:");
    expect(
      (
        await pool.query(
          "SELECT next_attempt_at>now() AS later FROM finance.card_refund_commands WHERE id=$1",
          [commandId],
        )
      ).rows[0].later,
    ).toBe(true);
    expect((await f.state()).refundRows).toEqual([]);
  });

  it("asks again for a failed refund, same amount, only when the latest one failed", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    const retry = async (commandKey: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const staged = await retryPricingCardRefund(client, {
          propertyId: f.propertyId,
          guestBookingId: f.guestBookingId,
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
    const { commandId } = (await f.stage("3000"))!;
    // Nothing failed yet: there is nothing to retry.
    await expect(retry("retry-early")).rejects.toMatchObject({ code: "unavailable" });
    stripe.state.next = "failed";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("failed");
    const again = await retry("retry-1");
    expect(again).toMatchObject({ amount: "70.00", currency: "EUR" });
    expect(await retry("retry-1")).toEqual(again);
    // The retry is now the live refund: another one is refused.
    await expect(retry("retry-2")).rejects.toMatchObject({ code: "unavailable" });
    stripe.state.next = "succeeded";
    expect(await executePricingCardRefund(pool, stripe.provider, again.commandId)).toBe(
      "succeeded",
    );
    vi.restoreAllMocks();
    expect(await f.state()).toMatchObject({
      payment: { status: "partially_refunded", refunded: "70.00" },
      commands: [{ status: "failed" }, { status: "succeeded", amount: "70.00" }],
    });
  });

  it("follows a refund an earlier attempt made after all, and never makes a second one (VAY-2205)", async () => {
    const f = await paidCardStay(),
      stripe = fakeStripe();
    const retry = async (commandKey: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const staged = await retryPricingCardRefund(client, {
          propertyId: f.propertyId,
          guestBookingId: f.guestBookingId,
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
    const { commandId } = (await f.stage("3000"))!;
    // Stripe made the refund, but its answer was lost and the command was recorded as failed.
    stripe.state.loseResponse = true;
    expect(await executePricingCardRefund(pool, stripe.provider, commandId)).toBe("pending");
    stripe.state.loseResponse = false;
    await pool.query(
      `UPDATE finance.card_refund_commands SET status='failed',settled_at=now(),failure_reason='lost'
       WHERE id=$1`,
      [commandId],
    );
    const again = await retry("retry-after-lost");
    expect(await executePricingCardRefund(pool, stripe.provider, again.commandId)).toBe(
      "succeeded",
    );
    // The retry took the refund Stripe already made: one refund, recorded once.
    expect(stripe.provider.createRefund).toHaveBeenCalledOnce();
    expect(await f.state()).toMatchObject({
      payment: { status: "partially_refunded", refunded: "70.00" },
      commands: [{ status: "failed" }, { status: "succeeded", amount: "70.00" }],
    });
  });

  it("refuses a payment the hotel's account can't refund", async () => {
    const f = await paidCardStay();
    await pool.query(
      `UPDATE finance.payments SET payment_metadata='{"chargeType":"destination"}' WHERE id=$1`,
      [f.paymentId],
    );
    await expect(f.stage("0")).rejects.toMatchObject({ code: "unavailable" });
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
