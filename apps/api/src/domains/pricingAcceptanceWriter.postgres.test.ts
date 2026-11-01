import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { readPricingCheckInPlace } from "./pricingManualPaymentLead.js";
import { writePricingAcceptance } from "./pricingAcceptanceWriter.js";
import {
  executePricingCardRefund,
  previewPricingCardRefund,
  stagePricingCardRefund,
} from "./pricingCardRefund.js";
import { reconcilePricingCardPayments } from "./pricingCardReconciliation.js";
import {
  completePricingCardPayment,
  expirePricingCardBooking,
} from "./pricingCardPaymentCompletion.js";
import { settleStripeBookingPayment } from "./stripeBookingSettlement.js";
import { createStripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { stripeAmountDecimal, stripeAmountMinor } from "./stripeMoney.js";
import { routeVayadaPaymentStripe } from "./vayadaPaymentStripe.js";
import { handleVayadaPaymentWebhookEvent } from "./vayadaPaymentWebhookEvents.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
import { calculateReplacementFixedCharges } from "./replacementFixedCharges.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { finishCurrentQuoteAcceptanceTime } from "./currentQuoteAcceptanceTime.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { createBookingHostActions } from "./bookingHostActions.js";
import {
  createTargetBookingWebCheckoutAdapter,
  issueTargetBookingConfirmationToken,
} from "../routes/bookingWebPublic.js";
import { createBankTransferBookingOperations } from "./financeBankTransferBooking.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import { targetBookingHostActionGuards } from "./bookingHostActionGuards.js";
import { createFinanceHostBookingPayments } from "./financeHostBookingPayments.js";
import type {
  PmsBookingLifecycleCommand,
  PmsOperationsReadRepository,
} from "../routes/pmsOperations.js";
import {
  createPgBookingLifecycleStore,
  runBookingLifecycleSchedulerJobs,
} from "../jobs/bookingLifecycle.js";
import { runBankTransferPaymentReminders } from "../jobs/bankTransferPaymentReminders.js";

vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteInventory.js", () => ({ reserveRevalidatedQuoteInventory: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./currentQuoteGuestDisclosure.js", () => ({ lockCurrentQuoteGuestDisclosure: vi.fn() }));
vi.mock("./financePricingAcceptanceTerms.js", () => ({
  lockFinancePricingAcceptanceTerms: vi.fn(),
}));
vi.mock("./currentQuoteAcceptanceTime.js", () => ({
  finishCurrentQuoteAcceptanceTime: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!url)("pricing acceptance writer transaction (PostgreSQL)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps every staged effect invisible until commit and replays without new writes", async () => {
    const fixture = await setupFixture();
    let staged!: () => void, release!: () => void;
    const stagedPromise = new Promise<void>((resolve) => (staged = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async (client) => {
      // Keep the shared worker suite from claiming this committed fixture before cleanup.
      await client.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      staged();
      await releasePromise;
      return new Date().toISOString();
    });

    const write = writePricingAcceptance(fixture.pool, fixture.input);
    await stagedPromise;
    const replay = writePricingAcceptance(fixture.pool, fixture.input);
    const secondPid = await waitForSecondWriter(fixture);
    await expect(isBlocked(fixture.observer, secondPid)).resolves.toBe(true);
    await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
      bookings: 0,
      acceptances: 0,
      jobs: 0,
      revenue: 0,
      available: 3,
      assigned: 0,
    });
    release();
    const accepted = await write;
    expect(accepted).toMatchObject({ kind: "accepted" });
    await expect(replay).resolves.toMatchObject({
      kind: "replayed",
      bookingId: accepted.bookingId,
    });
    const committed = await snapshot(fixture.observer, fixture);
    expect(committed).toEqual({
      bookings: 1,
      acceptances: 1,
      jobs: 2,
      revenue: 2,
      available: 2,
      assigned: 1,
    });
    expect(await snapshot(fixture.observer, fixture)).toEqual(committed);
    await fixture.close();
  });

  it("rolls back booking, inventory, revenue, acceptance and jobs after the final gate", async () => {
    const fixture = await setupFixture();
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockResolvedValue(fixture.f.finance.validUntil!);

    await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
      bookings: 0,
      acceptances: 0,
      jobs: 0,
      revenue: 0,
      available: 3,
      assigned: 0,
    });
    await fixture.close();
  });
});

describe.skipIf(!url)("pricing acceptance writer card payments (PostgreSQL)", () => {
  beforeEach(() => vi.resetAllMocks());
  const cardQuote = (quote: Fixture["f"]["current"]["quote"]) => {
    Object.assign(quote, { paymentMethod: "card" });
    Object.assign(quote.evidence, { dueNowMinor: quote.evidence.totalMinor, dueLaterMinor: "0" });
    Object.assign(quote.evidence.terms[0], {
      payment: { kind: "full", acceptedMethods: ["card"] },
    });
  };

  async function cardFixture(
    accountRef = "acct_writer_test",
    currency?: string,
    acceptanceMode: "instant" | "request" = "instant",
    changeQuote?: (quote: Fixture["f"]["current"]["quote"]) => void,
    futureStay: boolean | number = false,
  ) {
    const fixture = await setupFixture(
      (quote) => {
        cardQuote(quote);
        Object.assign(quote, { acceptanceMode });
        changeQuote?.(quote);
      },
      currency,
      futureStay,
    );
    const slug = `writer-${fixture.propertyId}`;
    fixture.input.slug = slug;
    await fixture.observer.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
      [fixture.propertyId, slug],
    );
    const accountId = randomUUID();
    // A K5 case that timed out keeps running and still holds the real test account's row, so every
    // later case would fail on the unique account id: rename the leftover instead.
    await fixture.observer.query(
      `UPDATE finance.payment_provider_accounts SET provider_account_id=provider_account_id||'_stale_'||left(id::text,8)
       WHERE provider='stripe' AND provider_account_id=$1`,
      [accountRef],
    );
    await fixture.observer.query(
      `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,
        onboarding_status,charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
       VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,'{}')`,
      [accountId, fixture.propertyId, accountRef],
    );
    await fixture.observer.query(
      `INSERT INTO finance.payment_settings(property_id,provider_account_id,payments_enabled,accepted_methods,default_currency)
       VALUES($1,$2,true,ARRAY['card'],$3)`,
      [fixture.propertyId, accountId, fixture.f.current.quote.stay.currency],
    );
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockResolvedValue(new Date().toISOString());
    const createPaymentIntent = vi.fn(async (input: { amountMinor: number; currency: string }) => ({
      paymentIntentId: "pi_writer_test",
      clientSecret: "pi_writer_test_secret",
      status: "requires_payment_method",
      amountMinor: input.amountMinor,
      currency: input.currency,
      propertyId: fixture.propertyId,
      bookingReference: null as string | null,
      providerAccountRef: "acct_writer_test",
    }));
    const retrievePaymentIntent = vi.fn(async () =>
      createPaymentIntent({
        amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
        currency: fixture.f.current.quote.stay.currency,
      }),
    );
    const cancelPaymentIntent = vi.fn();
    const provider = { createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } as never;
    return {
      fixture,
      slug,
      createPaymentIntent,
      retrievePaymentIntent,
      cancelPaymentIntent,
      provider,
    };
  }

  it("authorises a card request without capture, holding the rooms on the payment deadline only", async () => {
    const { fixture, createPaymentIntent, provider } = await cardFixture(
      undefined,
      undefined,
      "request",
    );
    try {
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }),
      ).rejects.toMatchObject({ code: "request_unavailable" });
      expect(createPaymentIntent).not.toHaveBeenCalled();
      const result = await writePricingAcceptance(fixture.pool, fixture.input, { provider }, true);
      expect(result).toMatchObject({ kind: "payment_required" });
      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ captureMethod: "manual" }),
      );
      const booking = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.booking_metadata ? 'pendingExpiresAt' AS payment_deadline,
            b.booking_metadata ? 'hostResponseDeadlineAt' AS host_deadline,
            p.payment_metadata->>'captureMethod' AS capture,p.payment_metadata->>'acceptanceMode' AS mode
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(booking).toEqual([
        {
          lifecycle_status: "pending_payment",
          payment_status: "unpaid",
          payment_deadline: true,
          host_deadline: false,
          capture: "manual",
          mode: "request",
        },
      ]);
      await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
        bookings: 1,
        acceptances: 1,
        jobs: 0,
        revenue: 0,
        available: 2,
        assigned: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  it("accepts the quote, holds the rooms and starts a Stripe payment without confirming", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, provider } =
      await cardFixture();
    try {
      await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
        code: "card_unavailable",
      });
      expect(createPaymentIntent).not.toHaveBeenCalled();

      const result = await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
      });
      expect(result).toMatchObject({
        kind: "payment_required",
        payment: {
          provider: "stripe",
          clientSecret: "pi_writer_test_secret",
          stripeAccountId: "acct_writer_test",
          paymentIntentId: "pi_writer_test",
        },
      });
      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAccountRef: "acct_writer_test",
          captureMethod: "automatic",
          currency: fixture.f.current.quote.stay.currency,
        }),
      );
      await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
        bookings: 1,
        acceptances: 1,
        jobs: 0,
        revenue: 0,
        available: 2,
        assigned: 1,
      });
      const booking = (
        await fixture.observer.query(
          `SELECT lifecycle_status,payment_status,expected_payment_method,active_card_payment_id IS NOT NULL AS linked,
            booking_metadata ? 'pendingExpiresAt' AS expires,booking_metadata->>'providerPaymentIntentId' AS intent
           FROM booking.guest_bookings WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(booking).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "unpaid",
        expected_payment_method: "unknown",
        linked: true,
        expires: true,
        intent: "pi_writer_test",
      });
      const payment = (
        await fixture.observer.query(
          "SELECT status,payment_method,provider_payment_intent_id FROM finance.payments WHERE property_id=$1",
          [fixture.propertyId],
        )
      ).rows;
      expect(payment).toEqual([
        {
          status: "requires_action",
          payment_method: "card",
          provider_payment_intent_id: "pi_writer_test",
        },
      ]);
      createPaymentIntent.mockClear();
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }),
      ).resolves.toMatchObject({
        kind: "payment_required",
        replayed: true,
        bookingId: (result as { bookingId: string }).bookingId,
        payment: { clientSecret: "pi_writer_test_secret", paymentIntentId: "pi_writer_test" },
      });
      expect(retrievePaymentIntent).toHaveBeenCalledWith("pi_writer_test", "acct_writer_test");
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        available: 2,
      });

      const reference = (result as { bookingReference: string }).bookingReference;
      const complete = () =>
        completePricingCardPayment(fixture.pool, provider, {
          slug,
          quoteId: fixture.f.current.quote.quoteId,
          requestId: fixture.f.command.requestId,
        });
      const intent = await createPaymentIntent({
        amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
        currency: fixture.f.current.quote.stay.currency,
      });
      retrievePaymentIntent.mockResolvedValue({ ...intent, bookingReference: reference });
      await expect(complete()).rejects.toMatchObject({ code: "pending" });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: reference,
        amountMinor: intent.amountMinor + 1,
        status: "succeeded",
      });
      await expect(complete()).rejects.toMatchObject({ code: "conflict" });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: reference,
        status: "succeeded",
      });
      await expect(complete()).resolves.toMatchObject({ kind: "accepted", replayed: false });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        jobs: expect.any(Number),
        available: 2,
      });
      const paid = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.balance_amount::text AS balance,p.status AS payment,
            (SELECT count(*)::int FROM booking.nightly_revenue_evidence r WHERE r.guest_booking_id=b.id) AS revenue,
            (SELECT count(*)::int FROM platform.jobs j WHERE j.property_id=b.property_id
              AND j.job_type='pms.reservation.accepted-pricing.create') AS pms
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(paid).toMatchObject({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        payment: "paid",
        pms: 1,
      });
      expect(Number(paid.balance)).toBe(0);
      expect(paid.revenue).toBeGreaterThan(0);
      await expect(complete()).resolves.toMatchObject({ kind: "accepted", replayed: true });
      expect(
        (
          await fixture.observer.query(
            "SELECT count(*)::int AS n FROM platform.jobs WHERE property_id=$1 AND job_type='pms.reservation.accepted-pricing.create'",
            [fixture.propertyId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("charges a vayada Payment hotel on Vayada's own Stripe account and owes it the rest (VAY-2442)", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent } = await cardFixture();
    try {
      // The hotel saved a payout account (P1): its provider account is bound as vayada:<property>.
      await fixture.observer.query(
        `UPDATE finance.payment_provider_accounts
         SET provider='vayada', provider_account_id='vayada:'||property_id::text
         WHERE property_id=$1`,
        [fixture.propertyId],
      );
      Object.assign(fixture.f.finance, { billingPlanSnapshot: "commission" });
      const connect = {
        createPaymentIntent: vi.fn(),
        retrievePaymentIntent: vi.fn(),
        cancelPaymentIntent: vi.fn(),
      };
      const own = { createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent: vi.fn() };
      const provider = routeVayadaPaymentStripe(connect as never, {
        provider: own as never,
        publishableKey: "pk_test_writer",
      });

      // While VAYADA_PAYMENT_ENABLED is off, nothing is charged and nothing is kept.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, {
          provider,
          vayada: { enabled: false, feePercent: 6 },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(createPaymentIntent).not.toHaveBeenCalled();
      expect((await snapshot(fixture.observer, fixture)).bookings).toBe(0);

      const result = await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
        vayada: { enabled: true, feePercent: 6 },
      });
      expect(result).toMatchObject({
        kind: "payment_required",
        payment: {
          provider: "stripe",
          stripeAccountId: null,
          publishableKey: "pk_test_writer",
          paymentIntentId: "pi_writer_test",
        },
      });
      const amountMinor = Number(fixture.f.current.quote.evidence.dueNowMinor);
      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountRef: null, applicationFeeAmountMinor: 0 }),
      );
      for (const fn of Object.values(connect)) expect(fn).not.toHaveBeenCalled();
      const payment = (
        await fixture.observer.query(
          `SELECT id,amount::text,fee_amount::text,net_amount::text,payment_metadata AS meta
           FROM finance.payments WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      const percent = Number(fixture.f.finance.commissionTermsSnapshot.bookingEngineFeePercent);
      const planFee = Math.round((amountMinor * percent) / 100);
      const vayadaFee = Math.round((amountMinor * 6) / 100);
      const currency = fixture.f.current.quote.stay.currency;
      expect(stripeAmountMinor(payment.fee_amount, currency)).toBe(planFee + vayadaFee);
      expect(stripeAmountMinor(payment.net_amount, currency)).toBe(
        amountMinor - planFee - vayadaFee,
      );
      expect(payment.meta).toMatchObject({
        chargeType: "vayada_payment",
        applicationFeeAmount: stripeAmountDecimal(0, currency),
        vayadaPaymentFeePercent: 6,
        vayadaPaymentFeeAmount: stripeAmountDecimal(vayadaFee, currency),
        platformFeeAmount: stripeAmountDecimal(planFee, currency),
      });

      // A replay answers with the same payment, still on Vayada's account.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, {
          provider,
          vayada: { enabled: true, feePercent: 6 },
        }),
      ).resolves.toMatchObject({
        replayed: true,
        payment: { stripeAccountId: null, publishableKey: "pk_test_writer" },
      });
      expect(retrievePaymentIntent).toHaveBeenLastCalledWith("pi_writer_test", null);

      const reference = (result as { bookingReference: string }).bookingReference;
      const intent = await createPaymentIntent({ amountMinor, currency });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: reference,
        status: "succeeded",
      });
      await expect(
        completePricingCardPayment(fixture.pool, provider, {
          slug,
          quoteId: fixture.f.current.quote.quoteId,
          requestId: fixture.f.command.requestId,
        }),
      ).resolves.toMatchObject({ kind: "accepted", replayed: false });
      const ledger = (
        await fixture.observer.query(
          `SELECT entry_kind,currency,gross_minor::int AS gross,fee_minor::int AS fee,net_minor::int AS net,livemode,
             payment_id::text,stay_check_out::text = (SELECT check_out::text FROM booking.guest_bookings
               WHERE property_id=$1) AS check_out,source_key
           FROM finance.hotel_payout_ledger WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(ledger).toEqual([
        {
          entry_kind: "charge",
          currency,
          gross: amountMinor,
          fee: planFee + vayadaFee,
          net: amountMinor - planFee - vayadaFee,
          payment_id: payment.id,
          // The fake intent says nothing about livemode: never counted as real money.
          livemode: false,
          check_out: true,
          source_key: `charge:${payment.id}`,
        },
      ]);
      // The ledger is append-only, and a charge counts once.
      await expect(
        fixture.observer.query(
          "UPDATE finance.hotel_payout_ledger SET net_minor=0 WHERE property_id=$1",
          [fixture.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.observer.query(
          `INSERT INTO finance.hotel_payout_ledger (property_id,entry_kind,currency,gross_minor,fee_minor,
             net_minor,guest_booking_id,payment_id,stay_check_out,livemode,source_key,occurred_at)
           SELECT property_id,entry_kind,currency,gross_minor,fee_minor,net_minor,guest_booking_id,
             payment_id,stay_check_out,livemode,'charge-again',now() FROM finance.hotel_payout_ledger
           WHERE property_id=$1`,
          [fixture.propertyId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await fixture.close();
    }
  });

  it("settles a vayada Payment stay from its webhook, refunds it on Vayada's account and nets disputes (VAY-2442)", async () => {
    const { fixture, createPaymentIntent, retrievePaymentIntent } = await cardFixture();
    try {
      await fixture.observer.query(
        `UPDATE finance.payment_provider_accounts
         SET provider='vayada', provider_account_id='vayada:'||property_id::text
         WHERE property_id=$1`,
        [fixture.propertyId],
      );
      Object.assign(fixture.f.finance, { billingPlanSnapshot: "commission" });
      const listRefunds = vi.fn(async () => []);
      const createRefund = vi.fn(
        async (input: { amountMinor: number; commandId: string; paymentIntentId: string }) => ({
          refundId: "re_vayada_test",
          status: "succeeded",
          amountMinor: input.amountMinor,
          currency: fixture.f.current.quote.stay.currency,
          paymentIntentId: input.paymentIntentId,
          commandId: input.commandId,
          failureReason: null,
        }),
      );
      const own = {
        createPaymentIntent,
        retrievePaymentIntent,
        cancelPaymentIntent: vi.fn(),
        listRefunds,
        createRefund,
      };
      const provider = routeVayadaPaymentStripe({} as never, {
        provider: own as never,
        publishableKey: "pk_test_writer",
      });
      await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
        vayada: { enabled: true, feePercent: 6 },
      });
      const amountMinor = Number(fixture.f.current.quote.evidence.dueNowMinor);
      const currency = fixture.f.current.quote.stay.currency;
      const log = { info: vi.fn(), warn: vi.fn() };
      const event = (type: string, object: Record<string, unknown>) =>
        handleVayadaPaymentWebhookEvent(
          fixture.pool,
          { id: `evt_${type}`, type, livemode: false, data: { object } },
          log,
        );
      const ledger = async () =>
        (
          await fixture.observer.query(
            `SELECT entry_kind,gross_minor::int AS gross,fee_minor::int AS fee,net_minor::int AS net,source_key
             FROM finance.hotel_payout_ledger WHERE property_id=$1 ORDER BY created_at,source_key`,
            [fixture.propertyId],
          )
        ).rows;

      // A dispute before the hotel was ever credited the payment takes nothing from it.
      await expect(
        event("charge.dispute.funds_withdrawn", {
          id: "dp_before_credit",
          amount: amountMinor,
          currency: currency.toLowerCase(),
          payment_intent: "pi_writer_test",
          balance_transactions: [
            { amount: -amountMinor, fee: 1500, currency: currency.toLowerCase() },
          ],
        }),
      ).resolves.toBe("ignored");
      expect(await ledger()).toEqual([]);

      // The guest closed the tab after paying: the webhook confirms the booking, once.
      const succeeded = {
        id: "pi_writer_test",
        amount_received: amountMinor,
        currency: currency.toLowerCase(),
      };
      await expect(event("payment_intent.succeeded", succeeded)).resolves.toBe("handled");
      await expect(event("payment_intent.succeeded", succeeded)).resolves.toBe("handled");
      const booking = (
        await fixture.observer.query(
          "SELECT id,lifecycle_status,payment_status FROM booking.guest_bookings WHERE property_id=$1",
          [fixture.propertyId],
        )
      ).rows[0];
      expect(booking).toMatchObject({ lifecycle_status: "confirmed", payment_status: "paid" });
      const percent = Number(fixture.f.finance.commissionTermsSnapshot.bookingEngineFeePercent);
      const planFee = Math.round((amountMinor * percent) / 100);
      const vayadaFee = Math.round((amountMinor * 6) / 100);
      expect(await ledger()).toMatchObject([
        { entry_kind: "charge", gross: amountMinor, fee: planFee + vayadaFee },
      ]);
      await expect(
        event("payment_intent.succeeded", { ...succeeded, id: "pi_somebody_else" }),
      ).resolves.toBe("ignored");

      // A dispute takes the amount and Stripe's fee; winning it gives the amount back. Twice
      // delivered, once counted.
      const dispute = (bt: Record<string, unknown>) => ({
        id: "dp_vayada_test",
        amount: amountMinor,
        currency: currency.toLowerCase(),
        payment_intent: "pi_writer_test",
        balance_transactions: [{ currency: currency.toLowerCase(), exchange_rate: null, ...bt }],
      });
      const withdrawn = dispute({ amount: -amountMinor, fee: 1500 });
      await expect(event("charge.dispute.funds_withdrawn", withdrawn)).resolves.toBe("handled");
      await expect(event("charge.dispute.funds_withdrawn", withdrawn)).resolves.toBe("handled");
      await event("charge.dispute.funds_reinstated", dispute({ amount: amountMinor, fee: 0 }));
      await expect(event("charge.dispute.created", dispute({}))).resolves.toBe("handled");
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ disputeId: "dp_vayada_test" }),
        expect.stringContaining("answer it in Stripe"),
      );

      // The hotel cancels: the refund runs on Vayada's account without an application fee; the
      // plan's fee on it comes back to the hotel, the vayada Payment fee doesn't.
      const client = await fixture.pool.connect();
      let staged: { commandId: string } | null;
      try {
        await client.query("BEGIN");
        staged = await stagePricingCardRefund(client, {
          propertyId: fixture.propertyId,
          guestBookingId: booking.id,
          retainedMinor: "0",
          requestedBy: "host",
          commandKey: "vayada-cancel",
          occurredAt: new Date(),
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(
        (
          await fixture.observer.query(
            "SELECT provider_account_ref FROM finance.card_refund_commands WHERE property_id=$1",
            [fixture.propertyId],
          )
        ).rows,
      ).toEqual([{ provider_account_ref: `vayada:${fixture.propertyId}` }]);
      await expect(
        executePricingCardRefund(fixture.pool, provider, staged!.commandId),
      ).resolves.toBe("succeeded");
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAccountRef: null,
          refundApplicationFee: false,
          amountMinor,
        }),
      );
      expect(await ledger()).toEqual(
        expect.arrayContaining([
          {
            entry_kind: "dispute",
            gross: -amountMinor,
            fee: 1500,
            net: -amountMinor - 1500,
            source_key: "dispute:dp_vayada_test:withdrawn",
          },
          {
            entry_kind: "dispute_reversal",
            gross: amountMinor,
            fee: 0,
            net: amountMinor,
            source_key: "dispute:dp_vayada_test:reinstated",
          },
          {
            entry_kind: "refund",
            gross: -amountMinor,
            fee: -planFee,
            net: -amountMinor + planFee,
            source_key: `refund:${staged!.commandId}`,
          },
        ]),
      );
      const balance = (
        await fixture.observer.query(
          `SELECT sum(net_minor)::int AS owed,count(DISTINCT stay_check_out)::int AS windows,
             bool_and(stay_check_out IS NOT NULL) AS dated
           FROM finance.hotel_payout_ledger WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      // Refunds and disputes net in the charge's payout window.
      expect(balance).toMatchObject({ windows: 1, dated: true });
      // A late copy of the payment event after the refund needs nothing and alarms nobody.
      log.warn.mockClear();
      await event("payment_intent.succeeded", succeeded);
      expect(log.warn).not.toHaveBeenCalled();
      // Fully refunded and the dispute lost then won: the hotel owes the vayada Payment fee and
      // Stripe's dispute fee.
      expect(balance.owed).toBe(-vayadaFee - 1500);
    } finally {
      await fixture.close();
    }
  });

  it("takes a deposit by card and leaves the rest to pay at the property, with deposits on (VAY-2205)", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, provider } =
      await cardFixture(undefined, "EUR", "instant", (quote) => {
        const total = BigInt(quote.evidence.totalMinor),
          dueNow = (total * 3000n + 5000n) / 10000n;
        Object.assign(quote.evidence, {
          dueNowMinor: String(dueNow),
          dueLaterMinor: String(total - dueNow),
        });
        Object.assign(quote.evidence.terms[0], {
          payment: {
            kind: "deposit",
            basisPoints: 3000,
            balanceDaysBeforeArrival: 0,
            acceptedMethods: ["card"],
          },
        });
      });
    const { dueNowMinor, dueLaterMinor } = fixture.f.current.quote.evidence;
    const decimal = (minor: string) => (Number(minor) / 100).toFixed(2);
    try {
      // With card on but deposits off, a deposit is unavailable, not a stale price.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }),
      ).rejects.toMatchObject({ code: "card_unavailable" });
      expect(createPaymentIntent).not.toHaveBeenCalled();

      const result = await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
        deposits: true,
      });
      expect(result).toMatchObject({ kind: "payment_required" });
      // Only the deposit is charged now.
      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: Number(dueNowMinor), captureMethod: "automatic" }),
      );
      expect(
        (
          await fixture.observer.query(
            "SELECT payment_kind,amount::text AS amount FROM finance.payments WHERE property_id=$1",
            [fixture.propertyId],
          )
        ).rows,
      ).toEqual([{ payment_kind: "deposit", amount: decimal(dueNowMinor) }]);

      const intent = await createPaymentIntent({
        amountMinor: Number(dueNowMinor),
        currency: "EUR",
      });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: (result as { bookingReference: string }).bookingReference,
        status: "succeeded",
      });
      await expect(
        completePricingCardPayment(fixture.pool, provider, {
          slug,
          quoteId: fixture.f.current.quote.quoteId,
          requestId: fixture.f.command.requestId,
        }),
      ).resolves.toMatchObject({ kind: "accepted", replayed: false });
      // Confirmed with the deposit paid; the rest stays due at the property.
      expect(
        (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,b.payment_status,b.total_amount::text AS total,b.balance_amount::text AS balance,
               p.status AS payment
             FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
             WHERE b.property_id=$1`,
            [fixture.propertyId],
          )
        ).rows,
      ).toEqual([
        {
          lifecycle_status: "confirmed",
          payment_status: "partially_paid",
          total: decimal(fixture.f.current.quote.evidence.totalMinor),
          balance: decimal(dueLaterMinor),
          payment: "paid",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("holds only a request's deposit and captures it when the hotel accepts, leaving the rest due (VAY-2205)", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } =
      await cardFixture(undefined, "EUR", "request", (quote) => {
        const total = BigInt(quote.evidence.totalMinor),
          dueNow = (total * 3000n + 5000n) / 10000n;
        Object.assign(quote.evidence, {
          dueNowMinor: String(dueNow),
          dueLaterMinor: String(total - dueNow),
        });
        Object.assign(quote.evidence.terms[0], {
          payment: {
            kind: "deposit",
            basisPoints: 3000,
            balanceDaysBeforeArrival: 0,
            acceptedMethods: ["card"],
          },
        });
      });
    const { dueNowMinor, dueLaterMinor } = fixture.f.current.quote.evidence;
    const decimal = (minor: string) => (Number(minor) / 100).toFixed(2);
    const capturePaymentIntent = vi.fn();
    const provider = {
      createPaymentIntent,
      retrievePaymentIntent,
      cancelPaymentIntent,
      capturePaymentIntent,
    } as never;
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      stripePaymentProvider: provider,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const hotelUser = randomUUID();
    try {
      await fixture.observer.query(
        "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
        [hotelUser, `${hotelUser}@example.test`],
      );
      const accepted = (await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        { provider, deposits: true },
        true,
      )) as { bookingId: string; bookingReference: string };
      // Only the deposit is held, to be captured when the hotel accepts.
      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: Number(dueNowMinor), captureMethod: "manual" }),
      );
      const intent = {
        ...(await createPaymentIntent({ amountMinor: Number(dueNowMinor), currency: "EUR" })),
        bookingReference: accepted.bookingReference,
      };
      retrievePaymentIntent.mockResolvedValue({ ...intent, status: "requires_capture" });
      await completePricingCardPayment(fixture.pool, provider, {
        slug,
        quoteId: fixture.f.current.quote.quoteId,
        requestId: fixture.f.command.requestId,
      });
      capturePaymentIntent.mockResolvedValue({ ...intent, status: "succeeded" });
      await expect(
        pms.acceptBooking({
          propertyId: fixture.propertyId,
          guestBookingId: accepted.bookingId,
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          audit: {
            actor: { kind: "user", userId: hotelUser, organizationId: fixture.organizationId },
            requestId: randomUUID(),
            reason: "Request accepted",
            requestedAt: new Date().toISOString(),
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(capturePaymentIntent).toHaveBeenCalledOnce();
      expect(
        (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,b.payment_status,b.balance_amount::text AS balance,p.status AS payment,
               p.amount::text AS paid,p.payment_kind
             FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
             WHERE b.id=$1`,
            [accepted.bookingId],
          )
        ).rows,
      ).toEqual([
        {
          lifecycle_status: "confirmed",
          payment_status: "partially_paid",
          balance: decimal(dueLaterMinor),
          payment: "paid",
          paid: decimal(dueNowMinor),
          payment_kind: "deposit",
        },
      ]);
    } finally {
      await pmsPool.end();
      await fixture.close();
    }
  });

  /** A confirmed instant stay that paid a 30% deposit by card (VAY-2205). */
  async function paidDeposit(cancellation?: unknown, commission = false) {
    const card = await cardFixture(undefined, "EUR", "instant", (quote) => {
      const total = BigInt(quote.evidence.totalMinor),
        dueNow = (total * 3000n + 5000n) / 10000n;
      Object.assign(quote.evidence, {
        dueNowMinor: String(dueNow),
        dueLaterMinor: String(total - dueNow),
      });
      Object.assign(quote.evidence.terms[0], {
        payment: {
          kind: "deposit",
          basisPoints: 3000,
          balanceDaysBeforeArrival: 0,
          acceptedMethods: ["card"],
        },
        ...(cancellation ? { cancellation } : {}),
      });
    });
    const { fixture, slug, provider, createPaymentIntent, retrievePaymentIntent } = card;
    // A commission plan (the fixture's plan is fixed, which takes no commission).
    if (commission) Object.assign(fixture.f.finance, { billingPlanSnapshot: "commission" });
    const result = (await writePricingAcceptance(fixture.pool, fixture.input, {
      provider,
      deposits: true,
    })) as { bookingId: string; bookingReference: string };
    const intent = await createPaymentIntent({
      amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
      currency: "EUR",
    });
    retrievePaymentIntent.mockResolvedValue({
      ...intent,
      bookingReference: result.bookingReference,
      status: "succeeded",
    });
    await completePricingCardPayment(fixture.pool, provider, {
      slug,
      quoteId: fixture.f.current.quote.quoteId,
      requestId: fixture.f.command.requestId,
    });
    const hotelUser = randomUUID();
    await fixture.observer.query(
      "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
      [hotelUser, `${hotelUser}@example.test`],
    );
    const createRefund = vi.fn(
      async (input: { amountMinor: number; commandId: string; paymentIntentId: string }) => ({
        refundId: "re_deposit",
        status: "succeeded",
        amountMinor: input.amountMinor,
        currency: "EUR",
        paymentIntentId: input.paymentIntentId,
        commandId: input.commandId,
        failureReason: null,
      }),
    );
    const stripe = {
      ...(provider as object),
      createRefund,
      listRefunds: vi.fn(async () => []),
      retrieveRefund: vi.fn(),
    } as never;
    const hostPool = new pg.Pool({ connectionString: url, max: 2 });
    const actions = createBookingHostActions({
      pool: hostPool,
      guards: {
        ...targetBookingHostActionGuards,
        payment: createFinanceHostBookingPayments(stripe),
      },
      inventory: { reserve: async () => null, release: async () => undefined },
      cardRefunds: stripe,
    });
    const scope = {
      propertyId: fixture.propertyId,
      bookingId: result.bookingId,
      actorUserId: hotelUser,
    };
    const money = async () =>
      (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,p.status AS payment,p.refunded_amount::text AS refunded,
             (SELECT string_agg(c.status||':'||c.amount::text,',') FROM finance.card_refund_commands c
              WHERE c.guest_booking_id=b.id) AS refunds
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.id=$1`,
          [result.bookingId],
        )
      ).rows[0];
    const close = async () => {
      await actions.close();
      await hostPool.end().catch(() => undefined);
      await fixture.close();
    };
    return { fixture, actions, scope, createRefund, money, close };
  }

  it("refunds the whole deposit when the hotel cancels a deposit stay for its own reason (VAY-2205)", async () => {
    const stay = await paidDeposit();
    const deposit = (Number(stay.fixture.f.current.quote.evidence.dueNowMinor) / 100).toFixed(2);
    try {
      const preview = await stay.actions.preview(stay.scope, {
        action: "cancel",
        reason: "Overbooked",
      });
      expect(preview.impact).toMatchObject({
        payment: "card_refund",
        cardRefund: {
          paidMinor: stay.fixture.f.current.quote.evidence.dueNowMinor,
          refundMinor: stay.fixture.f.current.quote.evidence.dueNowMinor,
        },
      });
      await stay.actions.apply(stay.scope, preview.previewId, "host-deposit");
      await vi.waitFor(async () =>
        expect(await stay.money()).toEqual({
          lifecycle_status: "canceled",
          payment_status: "refunded",
          payment: "refunded",
          refunded: deposit,
          refunds: `succeeded:${deposit}`,
        }),
      );
      expect(stay.createRefund).toHaveBeenCalledOnce();
    } finally {
      await stay.close();
    }
  });

  it("keeps a non-refundable deposit as retained revenue, as its share of the stay (VAY-2205)", async () => {
    const stay = await paidDeposit({ kind: "non_refundable" });
    const { totalMinor, dueNowMinor } = stay.fixture.f.current.quote.evidence;
    try {
      const preview = await stay.actions.preview(stay.scope, {
        action: "cancel",
        reason: "Guest emailed",
        cancellationKind: "guest_request",
      });
      expect(preview.impact).toMatchObject({
        payment: "card_refund",
        cardRefund: { paidMinor: dueNowMinor, refundMinor: "0" },
      });
      await stay.actions.apply(stay.scope, preview.previewId, "host-deposit-kept");
      // Nothing goes back, and the rest is never charged: the stay stays partly paid.
      expect(await stay.money()).toMatchObject({
        lifecycle_status: "canceled",
        payment_status: "partially_paid",
        payment: "paid",
        refunded: "0.00",
      });
      expect(stay.createRefund).not.toHaveBeenCalled();
      // The deposit is 30% of the stay, so the nights keep 30% of their room value, not all of it.
      const cents = async (event: string) =>
        BigInt(
          (
            await stay.fixture.observer.query(
              `SELECT COALESCE(SUM(gross_room_amount)*100,0)::bigint::text AS cents
               FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 AND economic_event=$2`,
              [stay.scope.bookingId, event],
            )
          ).rows[0].cents,
        );
      const room = await cents("room_night");
      expect(room).toBeGreaterThan(0n);
      const total = BigInt(totalMinor),
        kept = BigInt(dueNowMinor);
      expect(await cents("retained_charge")).toBe((room * kept * 2n + total) / (total * 2n));
    } finally {
      await stay.close();
    }
  });

  it("records the rest of a card deposit paid at the property, once, without counting the deposit twice (VAY-2205)", async () => {
    const stay = await paidDeposit(undefined, true);
    const { dueLaterMinor } = stay.fixture.f.current.quote.evidence;
    const rest = (Number(dueLaterMinor) / 100).toFixed(2);
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const command = (): PmsBookingLifecycleCommand => ({
      propertyId: stay.fixture.propertyId,
      guestBookingId: stay.scope.bookingId,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      audit: {
        actor: { kind: "system", service: "apps/api" },
        requestId: randomUUID(),
        reason: "Rest paid at the hotel",
        requestedAt: new Date().toISOString(),
      },
    });
    try {
      // The guest's confirmation says what the card paid and what is due at the hotel.
      const deposit = (Number(stay.fixture.f.current.quote.evidence.dueNowMinor) / 100).toFixed(2);
      const emails = (
        await stay.fixture.observer.query(
          "SELECT payload->>'text' AS text FROM platform.jobs WHERE property_id=$1 AND payload->>'recipientRole'='guest'",
          [stay.fixture.propertyId],
        )
      ).rows.map((row) => row.text as string);
      expect(emails.some((text) => text.includes(`Paid by card: ${deposit} EUR`))).toBe(true);
      expect(emails.some((text) => text.includes(`Due at the hotel: ${rest} EUR`))).toBe(true);
      // The balance is only the rest: the card deposit isn't taken off it a second time.
      await expect(pms.markBookingPaid(command())).resolves.toMatchObject({ ok: true });
      const state = (
        await stay.fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.balance_amount::text AS balance,
             (SELECT string_agg(p.payment_method||':'||p.amount::text,',' ORDER BY p.payment_method)
              FROM finance.payments p WHERE p.guest_booking_id=b.id AND p.status='paid') AS payments,
             (SELECT count(*)::int FROM booking.booking_status_events e
              WHERE e.guest_booking_id=b.id AND e.public_message='Remaining balance received.') AS events
           FROM booking.guest_bookings b WHERE b.id=$1`,
          [stay.scope.bookingId],
        )
      ).rows[0];
      expect(state).toMatchObject({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        balance: "0.00",
        events: 1,
      });
      expect(state.payments).toContain(`:${rest}`);
      expect(state.payments).toMatch(/^card:/);
      // Finance's 5% commission on the rest, once; the card deposit's row is unchanged.
      const fees = (
        await stay.fixture.observer.query(
          `SELECT payment_method,amount::text AS amount,fee_amount::text AS fee,net_amount::text AS net
           FROM finance.payments WHERE guest_booking_id=$1 AND status='paid' ORDER BY payment_method`,
          [stay.scope.bookingId],
        )
      ).rows;
      const cents = (v: string) => Math.round(Number(v) * 100);
      expect(fees).toHaveLength(2);
      const restRow = fees.find((row) => row.payment_method === "pay_at_property")!;
      expect(restRow.amount).toBe(rest);
      expect(cents(restRow.fee)).toBe(Math.round(cents(rest) * 0.05));
      expect(cents(restRow.fee)).toBeGreaterThan(0);
      expect(cents(restRow.net)).toBe(cents(rest) - cents(restRow.fee));
      // Paid in full now: a second record is refused.
      await expect(pms.markBookingPaid(command())).resolves.toMatchObject({
        ok: false,
        code: "invalid_status_transition",
      });
      // Part was paid at the property, so a cancel is the hotel's to settle: no automatic card
      // refund for the guest online, and the PMS asks for a payment adjustment.
      expect(
        await previewPricingCardRefund(stay.fixture.observer, {
          propertyId: stay.fixture.propertyId,
          guestBookingId: stay.scope.bookingId,
          retainedMinor: "0",
        }),
      ).toBeNull();
      const client = await stay.fixture.pool.connect();
      try {
        // The guest's cancel stages no card refund either.
        await client.query("BEGIN");
        await expect(
          stagePricingCardRefund(client, {
            propertyId: stay.fixture.propertyId,
            guestBookingId: stay.scope.bookingId,
            retainedMinor: "0",
            requestedBy: "guest",
            commandKey: "cancel-after-rest",
            occurredAt: new Date(),
          }),
        ).rejects.toMatchObject({ code: "unavailable" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      await expect(
        stay.actions.preview(stay.scope, { action: "cancel", reason: "Overbooked" }),
      ).rejects.toMatchObject({ code: "payment_adjustment_required" });
    } finally {
      await pmsPool.end();
      await stay.close();
    }
  });

  // Stripe test mode (VAY-1543 K5). Runs only with STRIPE_TEST_SECRET_KEY (a test-mode key) and
  // STRIPE_TEST_CONNECTED_ACCOUNT; CI has neither, so it never calls Stripe there. Optional
  // STRIPE_TEST_CURRENCY (EUR, USD or IDR) prices the quote in that currency.
  const stripeKey = process.env.STRIPE_TEST_SECRET_KEY;
  const stripeAccount = process.env.STRIPE_TEST_CONNECTED_ACCOUNT;
  const stripeTestMode =
    !!stripeKey && /^(sk|rk)_test_/.test(stripeKey) && !!stripeAccount?.startsWith("acct_");
  const stripeCurrency = process.env.STRIPE_TEST_CURRENCY?.toUpperCase();
  // Every K5 case calls Stripe several times: vitest's 5 s default is too short (2026-10-21 run).
  const stripeTestTimeout = 180_000;
  const confirmWithTestCard = async (paymentIntentId: string, paymentMethod: string) => {
    const response = await fetch(
      `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${stripeKey}:`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Account": stripeAccount!,
        },
        body: new URLSearchParams({ payment_method: paymentMethod }).toString(),
      },
    );
    return (await response.json()) as { status?: string; error?: { code?: string } };
  };

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: declined card stays pending, test Visa confirms the booking once",
    async () => {
      const { fixture } = await cardFixture(stripeAccount!, stripeCurrency);
      const provider = createStripeBookingPaymentProvider({ secretKey: stripeKey! });
      try {
        const required = (await writePricingAcceptance(fixture.pool, fixture.input, {
          provider,
        })) as {
          kind: string;
          bookingReference: string;
          payment: { paymentIntentId: string; clientSecret: string; stripeAccountId: string };
        };
        expect(required.kind).toBe("payment_required");
        expect(required.payment.stripeAccountId).toBe(stripeAccount);
        const intent = await provider.retrievePaymentIntent(
          required.payment.paymentIntentId,
          stripeAccount!,
        );
        expect(intent).toMatchObject({
          status: "requires_payment_method",
          amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
          currency: fixture.f.current.quote.stay.currency.toUpperCase(),
          propertyId: fixture.propertyId,
          bookingReference: required.bookingReference,
        });
        const complete = () =>
          completePricingCardPayment(fixture.pool, provider, {
            slug: fixture.input.slug,
            quoteId: fixture.f.current.quote.quoteId,
            requestId: fixture.f.command.requestId,
          });
        await expect(complete()).rejects.toMatchObject({ code: "pending" });
        const declined = await confirmWithTestCard(
          required.payment.paymentIntentId,
          "pm_card_chargeDeclined",
        );
        expect(declined.error?.code).toBe("card_declined");
        await expect(complete()).rejects.toMatchObject({ code: "pending" });
        // A retried acceptance returns the same open payment, not a second one.
        await expect(
          writePricingAcceptance(fixture.pool, fixture.input, { provider }),
        ).resolves.toMatchObject({
          kind: "payment_required",
          payment: { paymentIntentId: required.payment.paymentIntentId },
        });
        const paid = await confirmWithTestCard(required.payment.paymentIntentId, "pm_card_visa");
        expect(paid.status).toBe("succeeded");
        await expect(complete()).resolves.toMatchObject({ kind: "accepted", replayed: false });
        await expect(complete()).resolves.toMatchObject({ kind: "accepted", replayed: true });
        const state = (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,b.payment_status,p.status AS payment,
              (SELECT count(*)::int FROM booking.nightly_revenue_evidence r WHERE r.guest_booking_id=b.id) > 0 AS revenue,
              (SELECT count(*)::int FROM platform.jobs j WHERE j.property_id=b.property_id
                AND j.job_type='pms.reservation.accepted-pricing.create') AS pms
             FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
             WHERE b.property_id=$1`,
            [fixture.propertyId],
          )
        ).rows[0];
        expect(state).toEqual({
          lifecycle_status: "confirmed",
          payment_status: "paid",
          payment: "paid",
          revenue: true,
          pms: 1,
        });
      } finally {
        await fixture.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: an unpaid booking expires, Stripe cancels the payment, rooms are released",
    async () => {
      const { fixture } = await cardFixture(stripeAccount!, stripeCurrency);
      const provider = createStripeBookingPaymentProvider({ secretKey: stripeKey! });
      try {
        const required = (await writePricingAcceptance(fixture.pool, fixture.input, {
          provider,
        })) as { bookingId: string; payment: { paymentIntentId: string } };
        const releaseRooms = vi.fn(async () => undefined);
        const client = await fixture.pool.connect();
        try {
          await client.query("BEGIN");
          await expect(
            expirePricingCardBooking(
              client,
              provider,
              {
                propertyId: fixture.propertyId,
                guestBookingId: required.bookingId,
                now: new Date(Date.now() + 31 * 60_000),
              },
              releaseRooms,
            ),
          ).resolves.toBe("expired");
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        expect(releaseRooms).toHaveBeenCalledOnce();
        await expect(
          provider.retrievePaymentIntent(required.payment.paymentIntentId, stripeAccount!),
        ).resolves.toMatchObject({ status: "canceled" });
        const state = (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,p.status AS payment FROM booking.guest_bookings b
             JOIN finance.payments p ON p.id=b.active_card_payment_id WHERE b.property_id=$1`,
            [fixture.propertyId],
          )
        ).rows[0];
        expect(state).toEqual({ lifecycle_status: "expired", payment: "canceled" });
      } finally {
        await fixture.close();
      }
    },
    stripeTestTimeout,
  );

  // K5 for VAY-2205: refunds, holds and deposits against Stripe test mode, same gate as above.
  // Each stay is 30 days out, so a rate's cancellation tiers apply as they would for a guest.
  /** A K5 stay the guest paid (instant) or authorised (request) with a Stripe test card. */
  async function stripeTestStay(
    options: {
      mode?: "instant" | "request";
      deposit?: boolean;
      cancellation?: unknown;
      card?: string;
      /** A commission plan: the charge carries Vayada's application fee (the fixture's fixed plan has none). */
      commission?: boolean;
    } = {},
  ) {
    const mode = options.mode ?? "instant";
    const { fixture, slug } = await cardFixture(
      stripeAccount!,
      stripeCurrency,
      mode,
      (quote) => {
        if (options.deposit) {
          const total = BigInt(quote.evidence.totalMinor),
            dueNow = (total * 3000n + 5000n) / 10000n;
          Object.assign(quote.evidence, {
            dueNowMinor: String(dueNow),
            dueLaterMinor: String(total - dueNow),
          });
          Object.assign(quote.evidence.terms[0], {
            payment: {
              kind: "deposit",
              basisPoints: 3000,
              balanceDaysBeforeArrival: 0,
              acceptedMethods: ["card"],
            },
          });
        }
        if (options.cancellation)
          Object.assign(quote.evidence.terms[0], { cancellation: options.cancellation });
      },
      30,
    );
    if (options.commission) Object.assign(fixture.f.finance, { billingPlanSnapshot: "commission" });
    const provider = createStripeBookingPaymentProvider({ secretKey: stripeKey! });
    const required = (await writePricingAcceptance(
      fixture.pool,
      fixture.input,
      { provider, deposits: options.deposit },
      mode === "request",
    )) as { bookingId: string; bookingReference: string; payment: { paymentIntentId: string } };
    const intentId = required.payment.paymentIntentId;
    const confirmed = await confirmWithTestCard(intentId, options.card ?? "pm_card_visa");
    const complete = () =>
      completePricingCardPayment(fixture.pool, provider, {
        slug,
        quoteId: fixture.f.current.quote.quoteId,
        requestId: fixture.f.command.requestId,
      });
    if (confirmed.status === "succeeded" || confirmed.status === "requires_capture")
      await complete();
    const hotelUser = randomUUID();
    await fixture.observer.query(
      "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
      [hotelUser, `${hotelUser}@example.test`],
    );
    const hostPool = new pg.Pool({ connectionString: url, max: 2 });
    const actions = createBookingHostActions({
      pool: hostPool,
      guards: {
        ...targetBookingHostActionGuards,
        payment: createFinanceHostBookingPayments(provider),
      },
      inventory: { reserve: async () => null, release: async () => undefined },
      cardRefunds: provider,
    });
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      stripePaymentProvider: provider,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const scope = {
      propertyId: fixture.propertyId,
      bookingId: required.bookingId,
      actorUserId: hotelUser,
    };
    const accept = () =>
      pms.acceptBooking({
        propertyId: fixture.propertyId,
        guestBookingId: required.bookingId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        audit: {
          actor: { kind: "user", userId: hotelUser, organizationId: fixture.organizationId },
          requestId: randomUUID(),
          reason: "Request accepted",
          requestedAt: new Date().toISOString(),
        },
      });
    const cancel = async (cancellationKind?: "guest_request") => {
      const preview = await actions.preview(scope, {
        action: "cancel",
        reason: cancellationKind ? "Guest emailed" : "Overbooked",
        ...(cancellationKind ? { cancellationKind } : {}),
      });
      await actions.apply(scope, preview.previewId, `k5-${randomUUID()}`);
      return preview.impact as {
        cardRefund?: { paidMinor: string; refundMinor: string; currency: string };
      };
    };
    /** Follows the stay's refund as next-api's 60-second sweep does, without its 1, 2, 4… minute
     * waits: each pass makes the command due and runs it. If it is still pending after `seconds`,
     * fails with what Stripe last answered. */
    const followRefund = async (seconds = 90) => {
      for (let waited = 0; ; waited += 5) {
        const command = (
          await fixture.observer.query(
            `SELECT id,status,provider_status,provider_refund_id,failure_reason,attempts,amount::text AS amount
             FROM finance.card_refund_commands WHERE guest_booking_id=$1 ORDER BY created_at DESC LIMIT 1`,
            [required.bookingId],
          )
        ).rows[0];
        const settled = !command || command.status !== "pending";
        // Kept in the K5 log (the fixture deletes the rows when it closes): ids and statuses only.
        if (settled || waited >= seconds)
          console.info(`K5 refund command ${JSON.stringify(command ?? null)}`);
        if (settled) return command;
        if (waited >= seconds)
          throw new Error(
            `Refund still pending after ${seconds} s: Stripe status ${command.provider_status ?? "none"}, ` +
              `${command.attempts} attempt(s), last error ${command.failure_reason ?? "none"}`,
          );
        await fixture.observer.query(
          "UPDATE finance.card_refund_commands SET next_attempt_at=now() WHERE id=$1",
          [command.id],
        );
        await executePricingCardRefund(hostPool, provider, command.id);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    };
    const state = async () =>
      (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,p.status AS payment,p.payment_kind,
             p.refunded_amount::text AS refunded,
             (SELECT string_agg(c.status,',') FROM finance.card_refund_commands c
              WHERE c.guest_booking_id=b.id) AS refunds
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.id=$1`,
          [required.bookingId],
        )
      ).rows[0];
    const stripe = () => provider.retrievePaymentIntent(intentId, stripeAccount!);
    const close = async () => {
      await actions.close();
      await hostPool.end().catch(() => undefined);
      await pmsPool.end().catch(() => undefined);
      await fixture.close();
    };
    return {
      fixture,
      pool: hostPool,
      provider,
      required,
      intentId,
      confirmed,
      complete,
      accept,
      actions,
      scope,
      cancel,
      followRefund,
      state,
      stripe,
      close,
    };
  }
  // Stripe refunds from the hotel account's available balance, and a new test account has none:
  // the refund cases pay with Stripe's test card whose funds are available at once.
  const availableNow = "pm_card_bypassPending";

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: the hotel cancels a paid card stay for its own reason; Stripe refunds all of it, once",
    async () => {
      const stay = await stripeTestStay({ card: availableNow });
      try {
        const paid = (await stay.stripe()).amountMinor;
        const impact = await stay.cancel();
        expect(impact.cardRefund).toEqual({
          paidMinor: String(paid),
          refundMinor: String(paid),
          currency: stay.fixture.f.current.quote.stay.currency,
        });
        const command = await stay.followRefund();
        expect(command.status).toBe("succeeded");
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "canceled",
          payment_status: "refunded",
          payment: "refunded",
          refunds: "succeeded",
        });
        expect((await stay.stripe()).amountRefundedMinor).toBe(paid);
        // A second cancel is refused, and running the settled command again asks Stripe nothing.
        await expect(stay.cancel()).rejects.toMatchObject({ code: expect.any(String) });
        await expect(executePricingCardRefund(stay.pool, stay.provider, command.id)).resolves.toBe(
          "succeeded",
        );
        const refunds = await stay.provider.listRefunds(stay.intentId, stripeAccount!);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ status: "succeeded", amountMinor: paid });
        expect(refunds[0]!.commandId).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a commission-plan stay's refund also returns Vayada's fee, in proportion",
    async () => {
      const stay = await stripeTestStay({ card: availableNow, commission: true });
      try {
        const fee = (
          await stay.fixture.observer.query(
            "SELECT payment_metadata->>'applicationFeeAmount' AS fee FROM finance.payments WHERE guest_booking_id=$1",
            [stay.required.bookingId],
          )
        ).rows[0].fee as string;
        const feeMinor = Math.round(Number(fee) * 100);
        expect(feeMinor).toBeGreaterThan(0);
        const paid = await stay.stripe();
        await stay.cancel();
        expect((await stay.followRefund()).status).toBe("succeeded");
        expect((await stay.stripe()).amountRefundedMinor).toBe(paid.amountMinor);
        // The fee lives on the platform account: all of it went back with the full refund.
        const response = await fetch(
          `https://api.stripe.com/v1/application_fees?charge=${encodeURIComponent(paid.feeBreakdown!.chargeId)}`,
          {
            headers: { Authorization: `Basic ${Buffer.from(`${stripeKey}:`).toString("base64")}` },
          },
        );
        const fees = (await response.json()) as {
          data?: { amount: number; amount_refunded: number }[];
          error?: { message?: string };
        };
        expect(fees.error?.message).toBeUndefined();
        expect(fees.data?.[0]).toMatchObject({ amount: feeMinor, amount_refunded: feeMinor });
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a guest's cancel under a 50% partial-refund rate refunds half at Stripe",
    async () => {
      const stay = await stripeTestStay({
        card: availableNow,
        cancellation: {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 60,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
            flexibleCancellationType: "partial_refund",
            text: "Half back until arrival",
            partialRefundTiers: [{ minDaysBeforeCheckIn: 0, refundPercent: 50 }],
          },
        },
      });
      try {
        const paid = (await stay.stripe()).amountMinor;
        const impact = await stay.cancel("guest_request");
        const refund = Number(impact.cardRefund!.refundMinor);
        expect(refund).toBeGreaterThan(0);
        expect(refund).toBeLessThan(paid);
        expect(Math.abs(refund - paid / 2)).toBeLessThanOrEqual(paid / 100);
        expect((await stay.followRefund()).status).toBe("succeeded");
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "canceled",
          payment: "partially_refunded",
          refunds: "succeeded",
        });
        expect((await stay.stripe()).amountRefundedMinor).toBe(refund);
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a refund Stripe fails later shows up in the daily card check",
    async () => {
      // This card's funds wait in the pending balance, so a paid stay first puts money in the
      // available balance for the refund to come from.
      await (await stripeTestStay({ card: availableNow })).close();
      // Stripe's test card whose refunds succeed first and fail a little later.
      const stay = await stripeTestStay({ card: "pm_card_refundFail" });
      try {
        await stay.cancel();
        expect((await stay.followRefund()).status).toBe("succeeded");
        const [refund] = await stay.provider.listRefunds(stay.intentId, stripeAccount!);
        await vi.waitFor(
          async () => {
            expect(
              (await stay.provider.retrieveRefund(refund!.refundId, stripeAccount!)).status,
            ).toBe("failed");
          },
          { timeout: 90_000, interval: 5_000 },
        );
        const { mismatches } = await reconcilePricingCardPayments(
          stay.fixture.observer,
          stay.provider,
          1,
        );
        const kinds = mismatches
          .filter((m) => m.guestBookingId === stay.required.bookingId)
          .map((m) => m.kind);
        expect(kinds).toContain("refund_failed_later");
      } finally {
        await stay.close();
      }
    },
    300_000,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a card request's hold is captured when the hotel accepts",
    async () => {
      const stay = await stripeTestStay({ mode: "request" });
      try {
        expect(stay.confirmed.status).toBe("requires_capture");
        expect(await stay.state()).toMatchObject({ payment: "authorized" });
        await expect(stay.accept()).resolves.toMatchObject({ ok: true });
        expect(await stay.stripe()).toMatchObject({
          status: "succeeded",
          amountMinor: Number(stay.fixture.f.current.quote.evidence.dueNowMinor),
        });
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "confirmed",
          payment_status: "paid",
          payment: "paid",
        });
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: declining a card request voids the hold at Stripe",
    async () => {
      const stay = await stripeTestStay({ mode: "request" });
      try {
        const preview = await stay.actions.preview(stay.scope, {
          action: "reject",
          reason: "Fully booked",
        });
        await expect(
          stay.actions.apply(stay.scope, preview.previewId, "k5-decline"),
        ).resolves.toMatchObject({ lifecycleStatus: "declined" });
        expect((await stay.stripe()).status).toBe("canceled");
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "declined",
          payment: "canceled",
        });
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a 30% card deposit is charged alone, and the hotel's own cancel refunds exactly it",
    async () => {
      const stay = await stripeTestStay({ deposit: true, card: availableNow });
      const { dueNowMinor } = stay.fixture.f.current.quote.evidence;
      try {
        expect(await stay.stripe()).toMatchObject({
          status: "succeeded",
          amountMinor: Number(dueNowMinor),
        });
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "confirmed",
          payment_status: "partially_paid",
          payment_kind: "deposit",
        });
        const impact = await stay.cancel();
        expect(impact.cardRefund).toEqual({
          paidMinor: dueNowMinor,
          refundMinor: dueNowMinor,
          currency: stay.fixture.f.current.quote.stay.currency,
        });
        expect((await stay.followRefund()).status).toBe("succeeded");
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "canceled",
          payment: "refunded",
          refunds: "succeeded",
        });
        expect((await stay.stripe()).amountRefundedMinor).toBe(Number(dueNowMinor));
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a card request holds only its deposit and the hotel's accept captures that",
    async () => {
      const stay = await stripeTestStay({ mode: "request", deposit: true });
      const { dueNowMinor } = stay.fixture.f.current.quote.evidence;
      try {
        expect(stay.confirmed.status).toBe("requires_capture");
        await expect(stay.accept()).resolves.toMatchObject({ ok: true });
        expect(await stay.stripe()).toMatchObject({
          status: "succeeded",
          amountMinor: Number(dueNowMinor),
        });
        expect(await stay.state()).toMatchObject({
          lifecycle_status: "confirmed",
          payment_status: "partially_paid",
          payment: "paid",
          payment_kind: "deposit",
        });
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: a card that needs 3-D Secure leaves the booking waiting for the guest",
    async () => {
      const stay = await stripeTestStay({ card: "pm_card_threeDSecure2Required" });
      try {
        expect(stay.confirmed.status).toBe("requires_action");
        await expect(stay.complete()).rejects.toMatchObject({ code: "pending" });
        expect(await stay.state()).toMatchObject({ lifecycle_status: "pending_payment" });
      } finally {
        await stay.close();
      }
    },
    stripeTestTimeout,
  );

  it("records a card request the guest authorised and starts the hotel's 24 hours", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, provider } =
      await cardFixture(undefined, undefined, "request");
    try {
      const result = (await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        { provider },
        true,
      )) as { bookingId: string; bookingReference: string };
      const complete = () =>
        completePricingCardPayment(fixture.pool, provider, {
          slug,
          quoteId: fixture.f.current.quote.quoteId,
          requestId: fixture.f.command.requestId,
        });
      const intent = await createPaymentIntent({
        amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
        currency: fixture.f.current.quote.stay.currency,
      });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: result.bookingReference,
      });
      await expect(complete()).rejects.toMatchObject({ code: "pending" });
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: result.bookingReference,
        status: "requires_capture",
      });
      const authorized = (await complete()) as { kind: string; hostResponseDeadlineAt: string };
      expect(authorized).toMatchObject({
        kind: "requested",
        replayed: false,
        bookingId: result.bookingId,
        bookingReference: result.bookingReference,
      });
      const window = Date.parse(authorized.hostResponseDeadlineAt) - Date.now();
      expect(window).toBeGreaterThan(24 * 3600_000 - 120_000);
      expect(window).toBeLessThanOrEqual(24 * 3600_000);
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,p.status AS payment,s.payment_status AS summary,
            b.booking_metadata->>'hostResponseDeadlineAt' AS deadline,
            (SELECT count(*)::int FROM booking.nightly_revenue_evidence r WHERE r.guest_booking_id=b.id) AS revenue
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           JOIN booking.direct_booking_summary_read_model s ON s.guest_booking_id=b.id
           WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "authorized",
        payment: "authorized",
        summary: "authorized",
        deadline: authorized.hostResponseDeadlineAt,
        revenue: 0,
      });
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role FROM platform.jobs WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toContainEqual({ job_type: "email.booking-request-received", role: "guest" });
      expect(jobs.map((job) => job.job_type)).not.toContain(
        "pms.reservation.accepted-pricing.create",
      );
      await expect(complete()).resolves.toMatchObject({
        kind: "requested",
        replayed: true,
        hostResponseDeadlineAt: authorized.hostResponseDeadlineAt,
      });
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }, true),
      ).resolves.toMatchObject({ kind: "replayed", bookingId: result.bookingId });
    } finally {
      await fixture.close();
    }
  });

  it("records an authorised card request when the guest retries after a lost confirmation", async () => {
    const { fixture, retrievePaymentIntent, provider } = await cardFixture(
      undefined,
      undefined,
      "request",
    );
    try {
      const accepted = (await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        { provider },
        true,
      )) as { bookingId: string; bookingReference: string };
      const intent = await retrievePaymentIntent();
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: accepted.bookingReference,
        status: "requires_capture",
      });
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }, true),
      ).resolves.toMatchObject({ kind: "replayed", bookingId: accepted.bookingId });
      const state = (
        await fixture.observer.query(
          `SELECT lifecycle_status,payment_status,booking_metadata ? 'hostResponseDeadlineAt' AS deadline
           FROM booking.guest_bookings WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(state).toEqual([
        { lifecycle_status: "pending_payment", payment_status: "authorized", deadline: true },
      ]);
      // The next retry is a plain replay too, and records nothing twice.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }, true),
      ).resolves.toMatchObject({ kind: "replayed" });
      expect(
        (
          await fixture.observer.query(
            `SELECT count(*)::int AS n FROM booking.booking_status_events
             WHERE guest_booking_id=$1 AND event_type='guest_booking.payment_authorized'`,
            [accepted.bookingId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("captures an authorised card request when the hotel accepts, once", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } =
      await cardFixture(undefined, undefined, "request");
    const capturePaymentIntent = vi.fn();
    const provider = {
      createPaymentIntent,
      retrievePaymentIntent,
      cancelPaymentIntent,
      capturePaymentIntent,
    } as never;
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      stripePaymentProvider: provider,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const hotelUser = randomUUID();
    const accept = (bookingId: string) =>
      pms.acceptBooking({
        propertyId: fixture.propertyId,
        guestBookingId: bookingId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        audit: {
          actor: { kind: "user", userId: hotelUser, organizationId: fixture.organizationId },
          requestId: randomUUID(),
          reason: "Request accepted",
          requestedAt: new Date().toISOString(),
        },
      });
    try {
      await fixture.observer.query(
        "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
        [hotelUser, `${hotelUser}@example.test`],
      );
      const accepted = (await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        { provider },
        true,
      )) as { bookingId: string; bookingReference: string };
      const intent = {
        ...(await createPaymentIntent({
          amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
          currency: fixture.f.current.quote.stay.currency,
        })),
        bookingReference: accepted.bookingReference,
      };
      retrievePaymentIntent.mockResolvedValue({ ...intent, status: "requires_capture" });
      await completePricingCardPayment(fixture.pool, provider, {
        slug,
        quoteId: fixture.f.current.quote.quoteId,
        requestId: fixture.f.command.requestId,
      });
      // A hold Stripe will not capture leaves the request with the hotel.
      capturePaymentIntent.mockResolvedValueOnce({ ...intent, status: "canceled" });
      await expect(accept(accepted.bookingId)).resolves.toMatchObject({
        ok: false,
        code: "invalid_status_transition",
      });
      const state = async () =>
        (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,b.payment_status,p.status AS payment,s.lifecycle_status AS summary,
              (SELECT actor_user_id::text FROM booking.booking_status_events e
                WHERE e.guest_booking_id=b.id AND e.event_type='guest_booking.accepted') AS accepted_by,
              (SELECT count(*)::int FROM booking.nightly_revenue_evidence r WHERE r.guest_booking_id=b.id) AS revenue
             FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
             JOIN booking.direct_booking_summary_read_model s ON s.guest_booking_id=b.id
             WHERE b.property_id=$1`,
            [fixture.propertyId],
          )
        ).rows[0];
      expect(await state()).toMatchObject({
        lifecycle_status: "pending_payment",
        payment_status: "authorized",
        payment: "authorized",
      });

      capturePaymentIntent.mockResolvedValue({ ...intent, status: "succeeded" });
      await expect(accept(accepted.bookingId)).resolves.toMatchObject({ ok: true });
      expect(capturePaymentIntent).toHaveBeenLastCalledWith(
        "pi_writer_test",
        "acct_writer_test",
        expect.stringMatching(
          new RegExp(
            `^pricing-card-request-capture:${fixture.propertyId}:${accepted.bookingId}:[0-9a-f]{64}$`,
          ),
        ),
      );
      await fixture.observer.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      const confirmed = await state();
      expect(confirmed).toMatchObject({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        payment: "paid",
        summary: "confirmed",
        accepted_by: hotelUser,
      });
      expect(confirmed.revenue).toBeGreaterThan(0);
      const jobs = (
        await fixture.observer.query("SELECT job_type FROM platform.jobs WHERE property_id=$1", [
          fixture.propertyId,
        ])
      ).rows.map((row) => row.job_type);
      expect(jobs).toContain("email.booking-accepted");
      expect(jobs).toContain("pms.reservation.accepted-pricing.create");
      expect(jobs).not.toContain("email.booking-final-confirmation");

      // Stripe's capture webhook and a second click change nothing.
      await expect(
        settleStripeBookingPayment(fixture.observer, {
          paymentIntentId: "pi_writer_test",
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          occurredAt: new Date(),
          correlationId: "capture-webhook",
        }),
      ).resolves.toBe("already_settled");
      await expect(accept(accepted.bookingId)).resolves.toMatchObject({ ok: false });
      expect(capturePaymentIntent).toHaveBeenCalledTimes(2);
      expect((await state()).revenue).toBe(confirmed.revenue);
    } finally {
      await pmsPool.end();
      await fixture.close();
    }
  });

  // An authorised pricing-v2 card request, as the guest's confirm call leaves it.
  /** `vayada`: the hotel is on vayada Payment (VAY-2442), so its payment runs on Vayada's own
   * Stripe account through the router, and `connect` must never be called. */
  async function authorisedCardRequest(vayada = false) {
    const card = await cardFixture(undefined, undefined, "request");
    const capturePaymentIntent = vi.fn();
    const own = {
      createPaymentIntent: card.createPaymentIntent,
      retrievePaymentIntent: card.retrievePaymentIntent,
      cancelPaymentIntent: card.cancelPaymentIntent,
      capturePaymentIntent,
    };
    const connect = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      capturePaymentIntent: vi.fn(),
    };
    if (vayada)
      await card.fixture.observer.query(
        `UPDATE finance.payment_provider_accounts
         SET provider='vayada', provider_account_id='vayada:'||property_id::text WHERE property_id=$1`,
        [card.fixture.propertyId],
      );
    const provider = (
      vayada
        ? routeVayadaPaymentStripe(connect as never, {
            provider: own as never,
            publishableKey: "pk_test_writer",
          })
        : own
    ) as never;
    const accepted = (await writePricingAcceptance(
      card.fixture.pool,
      card.fixture.input,
      { provider, ...(vayada ? { vayada: { enabled: true, feePercent: 6 } } : {}) },
      true,
    )) as { bookingId: string; bookingReference: string };
    const intent = {
      ...(await card.createPaymentIntent({
        amountMinor: Number(card.fixture.f.current.quote.evidence.dueNowMinor),
        currency: card.fixture.f.current.quote.stay.currency,
      })),
      bookingReference: accepted.bookingReference,
    };
    card.retrievePaymentIntent.mockResolvedValue({ ...intent, status: "requires_capture" });
    const authorized = (await completePricingCardPayment(card.fixture.pool, provider, {
      slug: card.slug,
      quoteId: card.fixture.f.current.quote.quoteId,
      requestId: card.fixture.f.command.requestId,
    })) as { hostResponseDeadlineAt: string };
    const hotelUser = randomUUID();
    await card.fixture.observer.query(
      "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
      [hotelUser, `${hotelUser}@example.test`],
    );
    const status = async () =>
      (
        await card.fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,p.status AS payment
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.id=$1`,
          [accepted.bookingId],
        )
      ).rows[0];
    return {
      ...card,
      provider,
      connect,
      capturePaymentIntent,
      accepted,
      intent,
      authorized,
      hotelUser,
      status,
    };
  }

  it("never captures a hold after the hotel's deadline or one that is not the booking's own", async () => {
    const card = await authorisedCardRequest();
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      stripePaymentProvider: card.provider,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const accept = () =>
      pms.acceptBooking({
        propertyId: card.fixture.propertyId,
        guestBookingId: card.accepted.bookingId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        audit: {
          actor: {
            kind: "user",
            userId: card.hotelUser,
            organizationId: card.fixture.organizationId,
          },
          requestId: randomUUID(),
          reason: "Request accepted",
          requestedAt: new Date().toISOString(),
        },
      });
    try {
      await card.fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{hostResponseDeadlineAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1`,
        [card.accepted.bookingId],
      );
      await expect(accept()).resolves.toMatchObject({ ok: false });
      await card.fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{hostResponseDeadlineAt}',to_jsonb((clock_timestamp()+interval '1 hour')::text)) WHERE id=$1`,
        [card.accepted.bookingId],
      );
      card.retrievePaymentIntent.mockResolvedValue({
        ...card.intent,
        status: "requires_capture",
        amountMinor: card.intent.amountMinor + 1,
      });
      await expect(accept()).resolves.toMatchObject({ ok: false });
      card.retrievePaymentIntent.mockResolvedValue({
        ...card.intent,
        status: "requires_capture",
        bookingReference: "VAY-SOMEONEELSE",
      });
      await expect(accept()).resolves.toMatchObject({ ok: false });
      expect(card.capturePaymentIntent).not.toHaveBeenCalled();
      expect(await card.status()).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "authorized",
        payment: "authorized",
      });
    } finally {
      await pmsPool.end();
      await card.fixture.close();
    }
  });

  it.each([
    ["", false],
    [" (vayada Payment, on Vayada's own Stripe account, VAY-2442)", true],
  ])(
    "voids the hold and releases the rooms when the hotel declines a card request%s",
    async (_, vayada) => {
      const card = await authorisedCardRequest(vayada);
      const hostPool = new pg.Pool({ connectionString: url, max: 2 });
      const released: unknown[] = [];
      const actions = createBookingHostActions({
        pool: hostPool,
        guards: {
          ...targetBookingHostActionGuards,
          payment: createFinanceHostBookingPayments(card.provider),
        },
        inventory: {
          reserve: async () => null,
          async release({ reservation }) {
            released.push(reservation);
          },
        },
      });
      try {
        card.cancelPaymentIntent.mockResolvedValue({ ...card.intent, status: "canceled" });
        const scope = {
          propertyId: card.fixture.propertyId,
          bookingId: card.accepted.bookingId,
          actorUserId: card.hotelUser,
        };
        const preview = await actions.preview(scope, { action: "reject", reason: "Fully booked" });
        await expect(actions.apply(scope, preview.previewId, "decline-card")).resolves.toEqual({
          bookingId: card.accepted.bookingId,
          lifecycleStatus: "declined",
        });
        expect(card.cancelPaymentIntent).toHaveBeenCalledOnce();
        if (vayada)
          expect(card.cancelPaymentIntent).toHaveBeenCalledWith(
            card.intent.paymentIntentId,
            null,
            expect.any(String),
          );
        for (const fn of Object.values(card.connect)) expect(fn).not.toHaveBeenCalled();
        expect(card.capturePaymentIntent).not.toHaveBeenCalled();
        expect(released).toHaveLength(1);
        expect(await card.status()).toEqual({
          lifecycle_status: "declined",
          payment_status: "failed",
          payment: "canceled",
        });
      } finally {
        await actions.close();
        await hostPool.end().catch(() => undefined);
        await card.fixture.close();
      }
    },
  );

  it.each([
    ["", false],
    [" (vayada Payment, on Vayada's own Stripe account, VAY-2442)", true],
  ])(
    "cancels the hold and releases the rooms when the hotel lets a card request expire%s",
    async (_, vayada) => {
      const card = await authorisedCardRequest(vayada);
      const sweepPool = new pg.Pool({ connectionString: url, max: 2 });
      const released: unknown[] = [];
      const store = createPgBookingLifecycleStore({
        connectionString: url!,
        pool: sweepPool,
        stripePaymentProvider: card.provider,
        inventoryReservationPort: {
          reserve: async () => null,
          async release({ reservation }) {
            released.push(reservation);
          },
        },
      });
      try {
        await card.fixture.observer.query(
          "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
          [card.fixture.propertyId],
        );
        card.cancelPaymentIntent.mockResolvedValue({ ...card.intent, status: "canceled" });
        const deadline = Date.parse(card.authorized.hostResponseDeadlineAt);
        const sweep = (now: number) =>
          runBookingLifecycleSchedulerJobs(store, {
            now: new Date(now),
            run: ["pendingBookingExpiry"],
          });
        await sweep(deadline - 60_000);
        expect(card.cancelPaymentIntent).not.toHaveBeenCalled();
        const run = await sweep(deadline + 1_000);
        expect(run.failed).toBe(0);
        expect(card.cancelPaymentIntent).toHaveBeenCalledOnce();
        if (vayada)
          expect(card.cancelPaymentIntent).toHaveBeenCalledWith(
            card.intent.paymentIntentId,
            null,
            expect.any(String),
          );
        for (const fn of Object.values(card.connect)) expect(fn).not.toHaveBeenCalled();
        expect(released).toHaveLength(1);
        expect(await card.status()).toMatchObject({
          lifecycle_status: "expired",
          payment: "canceled",
        });
        const jobs = (
          await card.fixture.observer.query(
            "SELECT job_type FROM platform.jobs WHERE property_id=$1",
            [card.fixture.propertyId],
          )
        ).rows.map((row) => row.job_type);
        expect(jobs).toContain("email.booking-expired");
        expect(card.capturePaymentIntent).not.toHaveBeenCalled();
      } finally {
        await store.close();
        await sweepPool.end().catch(() => undefined);
        await card.fixture.close();
      }
    },
  );

  it("confirms a card request Stripe captured outside the hotel's accept", async () => {
    const card = await authorisedCardRequest();
    try {
      await expect(
        settleStripeBookingPayment(card.fixture.observer, {
          paymentIntentId: "pi_writer_test",
          amountMinor: card.intent.amountMinor,
          currency: card.intent.currency,
          occurredAt: new Date(),
          correlationId: "captured-elsewhere",
        }),
      ).resolves.toBe("settled");
      expect(await card.status()).toEqual({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        payment: "paid",
      });
      const event = (
        await card.fixture.observer.query(
          `SELECT actor_type,actor_user_id FROM booking.booking_status_events
           WHERE guest_booking_id=$1 AND event_type='guest_booking.accepted'`,
          [card.accepted.bookingId],
        )
      ).rows;
      expect(event).toEqual([{ actor_type: "system", actor_user_id: null }]);
      const jobs = (
        await card.fixture.observer.query(
          "SELECT job_type FROM platform.jobs WHERE property_id=$1",
          [card.fixture.propertyId],
        )
      ).rows.map((row) => row.job_type);
      expect(jobs).toContain("email.booking-accepted");
      expect(jobs).toContain("pms.reservation.accepted-pricing.create");
      await card.fixture.observer.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [card.fixture.propertyId],
      );
    } finally {
      await card.fixture.close();
    }
  });

  it("lets the guest withdraw an authorised card request: hold cancelled, rooms released", async () => {
    const card = await authorisedCardRequest();
    try {
      await card.fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [card.fixture.propertyId],
      );
      card.cancelPaymentIntent.mockResolvedValue({ ...card.intent, status: "canceled" });
      const { released } = await withdrawAsGuest(
        card.fixture,
        card.slug,
        card.accepted.bookingId,
        card.provider,
      );
      expect(card.cancelPaymentIntent).toHaveBeenCalledWith(
        "pi_writer_test",
        "acct_writer_test",
        expect.stringMatching(
          new RegExp(
            `^pricing-card-withdraw:${card.fixture.propertyId}:${card.accepted.bookingId}:[0-9a-f]{64}$`,
          ),
        ),
      );
      expect(card.capturePaymentIntent).not.toHaveBeenCalled();
      expect(released).toHaveLength(1);
      expect(await card.status()).toEqual({
        lifecycle_status: "canceled",
        payment_status: "failed",
        payment: "canceled",
      });
    } finally {
      await card.fixture.close();
    }
  });

  it("withdraws a card request whose cancel call failed once Stripe shows the hold cancelled", async () => {
    const card = await authorisedCardRequest();
    try {
      await card.fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [card.fixture.propertyId],
      );
      card.cancelPaymentIntent.mockRejectedValueOnce(new Error("Stripe timeout"));
      card.retrievePaymentIntent
        .mockResolvedValueOnce({ ...card.intent, status: "requires_capture" })
        .mockResolvedValueOnce({ ...card.intent, status: "canceled" });
      await withdrawAsGuest(card.fixture, card.slug, card.accepted.bookingId, card.provider);
      expect(await card.status()).toEqual({
        lifecycle_status: "canceled",
        payment_status: "failed",
        payment: "canceled",
      });
    } finally {
      await card.fixture.close();
    }
  });

  it("cancels the open payment when a guest withdraws an instant card booking before paying", async () => {
    const { fixture, slug, retrievePaymentIntent, cancelPaymentIntent, provider } =
      await cardFixture();
    try {
      await fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [fixture.propertyId],
      );
      const accepted = (await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
      })) as { bookingId: string; bookingReference: string };
      const intent = {
        ...(await retrievePaymentIntent()),
        bookingReference: accepted.bookingReference,
      };
      retrievePaymentIntent.mockResolvedValue(intent);
      cancelPaymentIntent.mockResolvedValue({ ...intent, status: "canceled" });
      const { released } = await withdrawAsGuest(fixture, slug, accepted.bookingId, provider);
      expect(cancelPaymentIntent).toHaveBeenCalledOnce();
      expect(released).toHaveLength(1);
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,p.status AS payment
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.id=$1`,
          [accepted.bookingId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "canceled",
        payment_status: "unpaid",
        payment: "canceled",
      });
    } finally {
      await fixture.close();
    }
  });

  it("refuses to withdraw a card request Stripe already captured, changing nothing", async () => {
    const card = await authorisedCardRequest();
    try {
      await card.fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [card.fixture.propertyId],
      );
      card.retrievePaymentIntent.mockClear();
      card.retrievePaymentIntent.mockResolvedValue({ ...card.intent, status: "succeeded" });
      await expect(
        withdrawAsGuest(card.fixture, card.slug, card.accepted.bookingId, card.provider),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("card payment can't be withdrawn online"),
      });
      // The withdraw itself asked Stripe, and found the money already taken.
      expect(card.retrievePaymentIntent).toHaveBeenCalledOnce();
      expect(card.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(await card.status()).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "authorized",
        payment: "authorized",
      });
    } finally {
      await card.fixture.close();
    }
  });

  it("records an authorised card request at its payment deadline instead of expiring it", async () => {
    const { fixture, provider, retrievePaymentIntent, cancelPaymentIntent } = await cardFixture(
      undefined,
      undefined,
      "request",
    );
    try {
      const accepted = (await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        { provider },
        true,
      )) as { bookingId: string; bookingReference: string };
      const intent = await retrievePaymentIntent();
      retrievePaymentIntent.mockResolvedValue({
        ...intent,
        bookingReference: accepted.bookingReference,
        status: "requires_capture",
      });
      const releaseRooms = vi.fn(async () => undefined);
      const client = await fixture.pool.connect();
      try {
        await client.query("BEGIN");
        await expect(
          expirePricingCardBooking(
            client,
            provider,
            {
              propertyId: fixture.propertyId,
              guestBookingId: accepted.bookingId,
              now: new Date(Date.now() + 31 * 60_000),
            },
            releaseRooms,
          ),
        ).resolves.toBe("authorized");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
      expect(releaseRooms).not.toHaveBeenCalled();
      const state = (
        await fixture.observer.query(
          `SELECT lifecycle_status,payment_status,booking_metadata ? 'hostResponseDeadlineAt' AS deadline
           FROM booking.guest_bookings WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "authorized",
        deadline: true,
      });
    } finally {
      await fixture.close();
    }
  });

  it("expires an unpaid card booking at its deadline, releases the rooms and never replays it as accepted", async () => {
    const { fixture, provider, retrievePaymentIntent, cancelPaymentIntent } = await cardFixture();
    try {
      const accepted = (await writePricingAcceptance(fixture.pool, fixture.input, {
        provider,
      })) as { bookingId: string; bookingReference: string };
      const intent = await retrievePaymentIntent();
      const bound = { ...intent, bookingReference: accepted.bookingReference };
      retrievePaymentIntent.mockResolvedValue(bound);
      cancelPaymentIntent.mockResolvedValue({ ...bound, status: "canceled" });
      const releaseRooms = vi.fn(async () => undefined);
      const expire = async (now: Date) => {
        const client = await fixture.pool.connect();
        try {
          await client.query("BEGIN");
          const outcome = await expirePricingCardBooking(
            client,
            provider,
            { propertyId: fixture.propertyId, guestBookingId: accepted.bookingId, now },
            releaseRooms,
          );
          await client.query("COMMIT");
          return outcome;
        } finally {
          client.release();
        }
      };
      await expect(expire(new Date())).resolves.toBe("pending");
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
      await expect(expire(new Date(Date.now() + 31 * 60_000))).resolves.toBe("expired");
      expect(cancelPaymentIntent).toHaveBeenCalledOnce();
      expect(releaseRooms).toHaveBeenCalledWith(
        expect.objectContaining({ inventoryReservation: expect.anything() }),
      );
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,p.status AS payment,
            (SELECT count(*)::int FROM platform.jobs j WHERE j.property_id=b.property_id) AS jobs
           FROM booking.guest_bookings b JOIN finance.payments p ON p.id=b.active_card_payment_id
           WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(state).toEqual({ lifecycle_status: "expired", payment: "canceled", jobs: 0 });
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, { provider }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
        code: "conflict",
      });
    } finally {
      await fixture.close();
    }
  });

  it("settles a card acceptance through the legacy Stripe settlement without the legacy PMS job", async () => {
    const { fixture, provider } = await cardFixture();
    try {
      await writePricingAcceptance(fixture.pool, fixture.input, { provider });
      const client = await fixture.pool.connect();
      try {
        await client.query("BEGIN");
        await expect(
          settleStripeBookingPayment(client, {
            paymentIntentId: "pi_writer_test",
            providerAccountRef: "acct_writer_test",
            amountMinor: Number(fixture.f.current.quote.evidence.dueNowMinor),
            currency: fixture.f.current.quote.stay.currency,
            occurredAt: new Date(),
            correlationId: "webhook-test",
          }),
        ).resolves.toBe("settled");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,
            (SELECT count(*)::int FROM platform.jobs j WHERE j.property_id=b.property_id
              AND j.job_type='pms.reservation.accepted-pricing.create') AS accepted_jobs,
            (SELECT count(*)::int FROM platform.jobs j WHERE j.property_id=b.property_id
              AND j.job_type='pms.reservation.create') AS legacy_jobs
           FROM booking.guest_bookings b WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        accepted_jobs: 1,
        legacy_jobs: 0,
      });
    } finally {
      await fixture.close();
    }
  });
});

describe.skipIf(!url)("pricing acceptance writer requests (PostgreSQL)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("holds the rooms for a pay-at-property request and asks the hotel, without revenue or PMS job", async () => {
    const fixture = await setupFixture((quote) =>
      Object.assign(quote, { acceptanceMode: "request" }),
    );
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
        code: "request_unavailable",
      });
      await expect(snapshot(fixture.observer, fixture)).resolves.toEqual({
        bookings: 0,
        acceptances: 0,
        jobs: 0,
        revenue: 0,
        available: 3,
        assigned: 0,
      });

      const requested = await writePricingAcceptance(fixture.pool, fixture.input, undefined, true);
      if (requested.kind !== "requested") throw new Error(`unexpected ${requested.kind}`);
      expect(requested.bookingReference).toMatch(/^VAY-[A-Z0-9]{32}$/);
      const window =
        Date.parse(requested.hostResponseDeadlineAt!) - Date.parse(requested.acceptedAt);
      expect(window).toBeGreaterThan(24 * 3600_000 - 60_000);
      expect(window).toBeLessThanOrEqual(24 * 3600_000);
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        revenue: 0,
        available: 2,
        assigned: 1,
      });
      const booking = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.expected_payment_method,
            b.booking_metadata->>'hostResponseDeadlineAt' AS deadline,
            b.booking_metadata ? 'pendingExpiresAt' AS payment_deadline,
            s.lifecycle_status AS summary,e.to_status AS event,e.public_message AS message
           FROM booking.guest_bookings b
           JOIN booking.direct_booking_summary_read_model s ON s.guest_booking_id=b.id
           JOIN booking.booking_status_events e ON e.guest_booking_id=b.id
           WHERE b.property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(booking).toEqual([
        {
          lifecycle_status: "pending_payment",
          payment_status: "unpaid",
          expected_payment_method: "pay_at_property",
          deadline: requested.hostResponseDeadlineAt,
          payment_deadline: false,
          summary: "pending_payment",
          event: "pending_payment",
          message: "We have received your booking request.",
        },
      ]);
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role FROM platform.jobs
           WHERE property_id=$1 ORDER BY job_type`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toContainEqual({ job_type: "email.booking-request-received", role: "guest" });
      expect(jobs.map((job) => job.job_type)).not.toContain(
        "pms.reservation.accepted-pricing.create",
      );
      expect(jobs.map((job) => job.job_type)).not.toContain("email.booking-final-confirmation");

      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, undefined, true),
      ).resolves.toMatchObject({ kind: "replayed", bookingId: requested.bookingId });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        jobs: jobs.length,
        available: 2,
      });
    } finally {
      await fixture.close();
    }
  });

  it("lets the hotel accept a request once, before its deadline, with revenue, email and PMS job", async () => {
    const fixture = await setupFixture((quote) =>
      Object.assign(quote, { acceptanceMode: "request" }),
    );
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const accept = (bookingId: string) =>
      pms.acceptBooking({
        propertyId: fixture.propertyId,
        guestBookingId: bookingId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        audit: {
          actor: { kind: "system", service: "apps/api" },
          requestId: randomUUID(),
          reason: "Request accepted",
          requestedAt: new Date().toISOString(),
        },
      });
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      const requested = await writePricingAcceptance(fixture.pool, fixture.input, undefined, true);
      // After the deadline the request is no longer the hotel's to accept.
      await fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{hostResponseDeadlineAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1`,
        [requested.bookingId],
      );
      await expect(accept(requested.bookingId)).resolves.toMatchObject({
        ok: false,
        code: "invalid_status_transition",
      });
      await fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{hostResponseDeadlineAt}',to_jsonb((clock_timestamp()+interval '1 hour')::text)) WHERE id=$1`,
        [requested.bookingId],
      );

      await expect(accept(requested.bookingId)).resolves.toMatchObject({ ok: true });
      // Keep the shared adoption worker from claiming this fixture's job before cleanup.
      await fixture.observer.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,s.lifecycle_status AS summary,
            (SELECT to_status FROM booking.booking_status_events
              WHERE guest_booking_id=b.id AND event_type='guest_booking.accepted') AS accepted_event
           FROM booking.guest_bookings b JOIN booking.direct_booking_summary_read_model s
             ON s.guest_booking_id=b.id WHERE b.id=$1`,
          [requested.bookingId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "confirmed",
        payment_status: "unpaid",
        summary: "confirmed",
        accepted_event: "confirmed",
      });
      const nights = fixture.f.current.quote.rooms.reduce((n, r) => n + r.nights.length, 0);
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        revenue: nights,
        available: 2,
        assigned: 1,
      });
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role FROM platform.jobs WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toContainEqual({ job_type: "email.booking-accepted", role: "guest" });
      expect(jobs).toContainEqual({
        job_type: "pms.reservation.accepted-pricing.create",
        role: null,
      });

      await expect(accept(requested.bookingId)).resolves.toMatchObject({
        ok: false,
        code: "invalid_status_transition",
      });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        revenue: nights,
        jobs: jobs.length,
      });
    } finally {
      await pmsPool.end();
      await fixture.close();
    }
  });

  it("lets the hotel decline a request: rooms released, guest told, no PMS job", async () => {
    const fixture = await setupFixture((quote) =>
      Object.assign(quote, { acceptanceMode: "request" }),
    );
    const hostPool = new pg.Pool({ connectionString: url, max: 2 });
    const released: unknown[] = [];
    const actions = createBookingHostActions({
      pool: hostPool,
      guards: targetBookingHostActionGuards,
      inventory: {
        reserve: async () => null,
        async release({ reservation }) {
          released.push(reservation);
        },
      },
    });
    const actorUserId = randomUUID();
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      const requested = await writePricingAcceptance(fixture.pool, fixture.input, undefined, true);
      await fixture.observer.query(
        "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
        [actorUserId, `${actorUserId}@example.test`],
      );
      const scope = { propertyId: fixture.propertyId, bookingId: requested.bookingId, actorUserId };
      const preview = await actions.preview(scope, { action: "reject", reason: "Fully booked" });
      await expect(actions.apply(scope, preview.previewId, "decline")).resolves.toEqual({
        bookingId: requested.bookingId,
        lifecycleStatus: "declined",
      });
      expect(released).toEqual([
        parsePmsInventoryReservationBundle(acceptanceFixture().inventory_reservation_bundle),
      ]);
      const jobs = (
        await fixture.observer.query(
          "SELECT job_type FROM platform.jobs WHERE property_id=$1 ORDER BY job_type",
          [fixture.propertyId],
        )
      ).rows.map((row) => row.job_type);
      expect(jobs).toContain("email.booking-rejected");
      expect(jobs.filter((job) => job.startsWith("pms."))).toEqual([]);
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({ revenue: 0 });
    } finally {
      await actions.close();
      await hostPool.end().catch(() => undefined);
      await fixture.close();
    }
  });

  it("lets the guest withdraw a request: rooms released, no PMS job", async () => {
    const fixture = await setupFixture((quote) =>
      Object.assign(quote, { acceptanceMode: "request" }),
    );
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      const slug = `writer-${fixture.propertyId}`;
      await fixture.observer.query(
        "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
        [fixture.propertyId, slug],
      );
      await fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [fixture.propertyId],
      );
      const requested = await writePricingAcceptance(fixture.pool, fixture.input, undefined, true);
      const { released } = await withdrawAsGuest(fixture, slug, requested.bookingId);
      expect(released).toEqual([
        parsePmsInventoryReservationBundle(acceptanceFixture().inventory_reservation_bundle),
      ]);
      const state = (
        await fixture.observer.query(
          "SELECT lifecycle_status,payment_status FROM booking.guest_bookings WHERE id=$1",
          [requested.bookingId],
        )
      ).rows[0];
      expect(state).toEqual({ lifecycle_status: "canceled", payment_status: "unpaid" });
      const jobs = (
        await fixture.observer.query("SELECT job_type FROM platform.jobs WHERE property_id=$1", [
          fixture.propertyId,
        ])
      ).rows.map((row) => row.job_type);
      expect(jobs.filter((job) => job.startsWith("pms."))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("expires an unanswered request: rooms released, guest and hotel told", async () => {
    const fixture = await setupFixture((quote) =>
      Object.assign(quote, { acceptanceMode: "request" }),
    );
    const sweepPool = new pg.Pool({ connectionString: url, max: 2 });
    const released: unknown[] = [];
    const store = createPgBookingLifecycleStore({
      connectionString: url!,
      pool: sweepPool,
      inventoryReservationPort: {
        reserve: async () => null,
        async release({ reservation }) {
          released.push(reservation);
        },
      },
    });
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await fixture.observer.query(
        `INSERT INTO hotel_catalog.property_contact_channels
          (property_id,channel_type,value,source_system,purpose)
         VALUES($1,'email','ops@writer.example.test','platform','operations')`,
        [fixture.propertyId],
      );
      // The sweep dates revenue corrections in the hotel's timezone.
      await fixture.observer.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
        [fixture.propertyId],
      );
      const requested = await writePricingAcceptance(fixture.pool, fixture.input, undefined, true);
      if (requested.kind !== "requested") throw new Error(`unexpected ${requested.kind}`);
      const deadline = new Date(requested.hostResponseDeadlineAt!);
      const sweep = (now: Date) =>
        runBookingLifecycleSchedulerJobs(store, { now, run: ["pendingBookingExpiry"] });
      await sweep(new Date(deadline.getTime() - 60_000));
      const status = async () =>
        (
          await fixture.observer.query(
            `SELECT b.lifecycle_status,s.lifecycle_status AS summary FROM booking.guest_bookings b
             JOIN booking.direct_booking_summary_read_model s ON s.guest_booking_id=b.id WHERE b.id=$1`,
            [requested.bookingId],
          )
        ).rows[0];
      expect(await status()).toEqual({
        lifecycle_status: "pending_payment",
        summary: "pending_payment",
      });
      expect(released).toEqual([]);

      const expiredRun = await sweep(new Date(deadline.getTime() + 1_000));
      expect(expiredRun.failed).toBe(0);
      expect((await status()).lifecycle_status).toBe("expired");
      expect(released).toEqual([
        parsePmsInventoryReservationBundle(acceptanceFixture().inventory_reservation_bundle),
      ]);
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role,payload->>'to' AS recipient
           FROM platform.jobs WHERE property_id=$1 AND queue_name='platform.email'`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toContainEqual(
        expect.objectContaining({ job_type: "email.booking-expired", role: "guest" }),
      );
      expect(jobs).toContainEqual({
        job_type: "email.booking-host-request-expired",
        role: "host",
        recipient: "ops@writer.example.test",
      });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({ revenue: 0 });
      await sweep(new Date(deadline.getTime() + 120_000));
      expect(released).toHaveLength(1);
    } finally {
      await store.close();
      await sweepPool.end().catch(() => undefined);
      await fixture.close();
    }
  });
});

// K5 in another currency (STRIPE_TEST_CURRENCY): the same quote with every minor amount scaled, so the
// card amount clears Stripe's minimum charge (EUR 360.00 becomes IDR 3,600,000.00).
const CURRENCY_SCALE: Record<string, bigint> = { EUR: 1n, USD: 1n, IDR: 10000n };
function inCurrency(quote: Fixture["f"]["current"]["quote"], currency: string) {
  const factor = CURRENCY_SCALE[currency];
  if (factor === undefined) throw new Error(`unsupported test currency ${currency}`);
  const scale = (value: unknown, minor = false): unknown =>
    Array.isArray(value)
      ? value.map((item) => scale(item, minor))
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, scale(item, key.endsWith("Minor"))]),
          )
        : minor && typeof value === "string" && /^[0-9]+$/.test(value)
          ? String(BigInt(value) * factor)
          : value;
  Object.assign(quote, scale(quote));
  Object.assign(quote.evidence, { currency });
  Object.assign(quote.stay, { currency });
}

/** Guest withdraw through the real booking-web adapter (its own transaction and command). */
async function withdrawAsGuest(
  fixture: Fixture,
  slug: string,
  bookingId: string,
  provider?: never,
) {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const released: unknown[] = [];
  const adapter = createTargetBookingWebCheckoutAdapter({
    pool,
    connectionString: url!,
    externalChanges: externalBookingChanges,
    inventoryReservationPort: {
      reserve: async () => null,
      async release({ reservation }: { reservation: unknown }) {
        released.push(reservation);
      },
    } as never,
    ...(provider ? { stripePaymentProvider: provider } : {}),
  });
  const key = randomUUID();
  try {
    const result = await adapter.withdraw(
      slug,
      bookingId,
      { guest_email: fixture.f.command.guest.email },
      {
        operation: "booking-withdraw",
        requestId: `request-${key}`,
        correlationId: `correlation-${key}`,
        idempotencyKey: key,
        fingerprint: hash(key),
        occurredAt: new Date(),
      } as never,
    );
    return { result, released };
  } finally {
    await pool.end();
  }
}

describe.skipIf(!url)("pricing acceptance writer bank transfer and PayPal (PostgreSQL)", () => {
  beforeEach(() => vi.resetAllMocks());
  const manualQuote = (method: string, acceptanceMode: "instant" | "request") => {
    return (quote: Fixture["f"]["current"]["quote"]) => {
      Object.assign(quote, { paymentMethod: method, acceptanceMode });
      Object.assign(quote.evidence, { dueNowMinor: quote.evidence.totalMinor, dueLaterMinor: "0" });
      Object.assign(quote.evidence.terms[0], {
        payment: { kind: "full", acceptedMethods: [method] },
      });
    };
  };
  const bankOperations = () =>
    createBankTransferBookingOperations(url!, {
      async encrypt() {
        throw new Error("not used");
      },
      decrypt: async () => ({
        accountHolder: "Writer Hotel",
        accountType: "iban" as const,
        accountNumber: "DE89370400440532013000",
        bankName: "Writer Bank",
        bicSwift: "",
        instructions: "",
      }),
    });
  async function finance(fixture: Fixture, method: string, depositPolicy: object = {}) {
    await fixture.observer.query(
      `INSERT INTO hotel_catalog.property_contact_channels
        (property_id,channel_type,value,source_system,purpose)
       VALUES($1,'email','ops@writer.example.test','platform','operations')`,
      [fixture.propertyId],
    );
    await fixture.observer.query(
      `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency,deposit_policy)
       VALUES($1,true,ARRAY[$2],$3,$4)`,
      [fixture.propertyId, method, fixture.f.current.quote.stay.currency, depositPolicy],
    );
    if (method === "bank_transfer")
      await fixture.observer.query(
        `INSERT INTO finance.bank_transfer_destinations(property_id,revision,ciphertext,key_arn,account_last4)
         VALUES($1,1,$2,'key','3000')`,
        [fixture.propertyId, Buffer.alloc(40)],
      );
  }
  const bookingRow = async (fixture: Fixture, bookingId: string) =>
    (
      await fixture.observer.query(
        `SELECT b.lifecycle_status,b.payment_status,b.expected_payment_method,
          b.booking_metadata->>'pendingExpiresAt' AS deadline,
          b.booking_metadata ? 'hostResponseDeadlineAt' AS host_deadline,
          b.booking_metadata->'paymentInstructions' AS instructions,
          e.public_message AS message,
          EXISTS(SELECT 1 FROM finance.bank_transfer_bookings t WHERE t.guest_booking_id=b.id) AS bank_bound
         FROM booking.guest_bookings b JOIN booking.booking_status_events e ON e.guest_booking_id=b.id
         WHERE b.id=$1`,
        [bookingId],
      )
    ).rows[0];

  it("holds the rooms for a bank transfer until a 48-hour deadline and binds the bank details", async () => {
    const fixture = await setupFixture(manualQuote("bank_transfer", "request"), undefined, true);
    const bank = bankOperations();
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "bank_transfer");
      const accept = (manual?: Parameters<typeof writePricingAcceptance>[4]) =>
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, manual);
      // Off, or on without the bank-details binding: unavailable, nothing written.
      for (const manual of [undefined, {}])
        await expect(accept(manual)).rejects.toMatchObject({ code: "manual_unavailable" });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 0,
        available: 3,
      });

      // Request mode needs no request switch: the hotel's step is confirming the payment.
      const pending = await accept({ bankTransfers: bank });
      if (pending.kind !== "payment_pending" || !("acceptedAt" in pending))
        throw new Error(`unexpected ${pending.kind}`);
      const quote = fixture.f.current.quote;
      expect(pending).toMatchObject({
        propertyId: fixture.propertyId,
        payment: {
          method: "bank_transfer",
          amountMinor: quote.evidence.totalMinor,
          currency: quote.stay.currency,
        },
      });
      const window = Date.parse(pending.payment.deadlineAt) - Date.parse(pending.acceptedAt);
      expect(window).toBeGreaterThan(48 * 3600_000 - 60_000);
      expect(window).toBeLessThanOrEqual(48 * 3600_000);
      expect(await bookingRow(fixture, pending.bookingId)).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "unpaid",
        expected_payment_method: "bank_transfer",
        deadline: pending.payment.deadlineAt,
        host_deadline: false,
        instructions: null,
        message: "We are waiting for your bank transfer.",
        bank_bound: true,
      });
      // Rooms held; no revenue and no PMS job until the hotel confirms the payment.
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        bookings: 1,
        acceptances: 1,
        revenue: 0,
        available: 2,
        assigned: 1,
      });
      // The guest gets the instructions (bank details added when sent), the hotel is told.
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role,
            (payload->>'requiresBankTransferInstructions')::boolean AS bank
           FROM platform.jobs WHERE property_id=$1 ORDER BY job_type`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toEqual([
        { job_type: "email.booking-host-payment-pending", role: "host", bank: false },
        { job_type: "email.booking-reserved-pending-payment", role: "guest", bank: true },
      ]);

      // A replay answers with the same pending payment.
      await expect(accept({ bankTransfers: bank })).resolves.toEqual({
        kind: "payment_pending",
        bookingId: pending.bookingId,
        bookingReference: pending.bookingReference,
        propertyId: fixture.propertyId,
        replayed: true,
        payment: pending.payment,
      });
      // The confirmation token opens the bank details for this booking.
      const token = await issueTargetBookingConfirmationToken(
        fixture.observer,
        { guestBookingId: pending.bookingId, propertyId: fixture.propertyId },
        new Date(),
      );
      await expect(
        bank.confirmation({
          propertyId: fixture.propertyId,
          bookingId: pending.bookingId,
          tokenHash: createHash("sha256").update(token.token).digest("hex"),
        }),
      ).resolves.toContain("IBAN: DE89370400440532013000");
      // Past the deadline but not yet swept: a retry is a conflict, not a pending payment.
      await fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{pendingExpiresAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1`,
        [pending.bookingId],
      );
      await expect(accept({ bankTransfers: bank })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await bank.close();
      await fixture.close();
    }
  });

  it("holds the rooms for PayPal within the hotel's window and keeps the PayPal email for the guest", async () => {
    const fixture = await setupFixture(manualQuote("paypal", "instant"), undefined, true);
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "paypal", { paypalEmail: "not an email" });
      const accept = () =>
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, { paypal: true });
      // The hotel's PayPal email went bad after the quote: a conflict, nothing written.
      await expect(accept()).rejects.toMatchObject({ code: "conflict" });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({ bookings: 0 });
      await fixture.observer.query(
        `UPDATE finance.payment_settings SET deposit_policy=
          '{"paypalEmail":" pay@writer.example.test ","paypalPaymentWindowHours":6}' WHERE property_id=$1`,
        [fixture.propertyId],
      );
      // VAY-2139: with PayPal's own switch off, a PayPal quote is unavailable and nothing is written.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
          bankTransfers: bankOperations(),
        }),
      ).rejects.toMatchObject({ code: "manual_unavailable" });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({ bookings: 0 });
      const pending = await accept();
      if (pending.kind !== "payment_pending" || !("acceptedAt" in pending))
        throw new Error(`unexpected ${pending.kind}`);
      expect(pending.payment.method).toBe("paypal");
      // A PayPal booking made while PayPal was on still replays after it is switched off.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
          bankTransfers: bankOperations(),
        }),
      ).resolves.toMatchObject({
        kind: "payment_pending",
        bookingId: pending.bookingId,
        replayed: true,
      });
      const window = Date.parse(pending.payment.deadlineAt) - Date.parse(pending.acceptedAt);
      expect(window).toBeGreaterThan(6 * 3600_000 - 60_000);
      expect(window).toBeLessThanOrEqual(6 * 3600_000);
      expect(await bookingRow(fixture, pending.bookingId)).toEqual({
        lifecycle_status: "pending_payment",
        payment_status: "unpaid",
        expected_payment_method: "unknown",
        deadline: pending.payment.deadlineAt,
        host_deadline: false,
        instructions: { paypalEmail: "pay@writer.example.test", paypalPaymentWindowHours: 6 },
        message: "We are waiting for your PayPal payment.",
        bank_bound: false,
      });
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        revenue: 0,
        available: 2,
      });
    } finally {
      await fixture.close();
    }
  });
  it("refuses bank transfer when check-in is closer than its deadline, and takes PayPal with a short window (VAY-2145)", async () => {
    // Check-in is tomorrow at 00:00 in Rome (no check-in time): inside the 48-hour bank deadline.
    const bankFixture = await setupFixture(manualQuote("bank_transfer", "instant"), undefined, 1);
    try {
      mockOwners(bankFixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(bankFixture, "bank_transfer");
      await expect(
        writePricingAcceptance(bankFixture.pool, bankFixture.input, undefined, false, {
          bankTransfers: bankOperations(),
        }),
      ).rejects.toMatchObject({ code: "manual_unavailable" });
      await expect(snapshot(bankFixture.observer, bankFixture)).resolves.toMatchObject({
        bookings: 0,
      });
    } finally {
      await bankFixture.close();
    }
    // Two days out, a six-hour PayPal window ends well before check-in.
    const paypalFixture = await setupFixture(manualQuote("paypal", "instant"), undefined, 2);
    try {
      mockOwners(paypalFixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(paypalFixture, "paypal", {
        paypalEmail: "pay@writer.example.test",
        paypalPaymentWindowHours: 6,
      });
      const pending = await writePricingAcceptance(
        paypalFixture.pool,
        paypalFixture.input,
        undefined,
        false,
        { paypal: true },
      );
      expect(pending.kind).toBe("payment_pending");
    } finally {
      await paypalFixture.close();
    }
  });
  it("reads the check-in time guests see: the guest rules, then the policy summary (VAY-2145)", async () => {
    const fixture = await setupFixture(manualQuote("paypal", "instant"), undefined, true);
    const read = () => readPricingCheckInPlace(fixture.observer, fixture.propertyId);
    try {
      await fixture.observer.query("BEGIN");
      await expect(read()).resolves.toMatchObject({
        place: { timeZone: "Europe/Rome", checkInTime: null },
      });
      await fixture.observer.query(
        "INSERT INTO hotel_catalog.property_policy_summaries(property_id,check_in_time) VALUES($1,'18:00')",
        [fixture.propertyId],
      );
      await expect(read()).resolves.toMatchObject({ place: { checkInTime: "18:00" } });
      const [actor, revision] = [randomUUID(), randomUUID()];
      await fixture.observer.query(
        "INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')",
        [actor, `guest-rules-${actor}@example.test`],
      );
      await fixture.observer.query(
        `INSERT INTO booking.guest_choice_revisions
           (revision,property_id,organization_id,actor_user_id,choices,request_id,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          revision,
          fixture.propertyId,
          fixture.organizationId,
          actor,
          { checkInTime: "15:30" },
          `guest-rules-${revision}`,
          "a".repeat(64),
        ],
      );
      await fixture.observer.query(
        "INSERT INTO booking.guest_choice_heads(property_id,revision) VALUES($1,$2)",
        [fixture.propertyId, revision],
      );
      // The guest rules shown on /book win over an older summary.
      await expect(read()).resolves.toMatchObject({ place: { checkInTime: "15:30" } });
    } finally {
      await fixture.observer.query("ROLLBACK");
      await fixture.close();
    }
  });
  it("expires an unpaid bank transfer at its deadline, releases the rooms and tells both sides", async () => {
    const fixture = await setupFixture(manualQuote("bank_transfer", "instant"), undefined, true);
    const bank = bankOperations();
    const sweepPool = new pg.Pool({ connectionString: url, max: 2 });
    const released: unknown[] = [];
    const store = createPgBookingLifecycleStore({
      connectionString: url!,
      pool: sweepPool,
      inventoryReservationPort: {
        reserve: async () => null,
        async release({ reservation }) {
          released.push(reservation);
        },
      },
    });
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "bank_transfer");
      // The sweep dates revenue corrections in the hotel's timezone (Europe/Rome, from the fixture).
      const pending = await writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
        bankTransfers: bank,
      });
      if (pending.kind !== "payment_pending" || !("acceptedAt" in pending))
        throw new Error(`unexpected ${pending.kind}`);
      const deadline = Date.parse(pending.payment.deadlineAt);
      const sweep = (now: number) =>
        runBookingLifecycleSchedulerJobs(store, {
          now: new Date(now),
          run: ["pendingBookingExpiry"],
        });
      await sweep(deadline - 60_000);
      expect((await bookingRow(fixture, pending.bookingId)).lifecycle_status).toBe(
        "pending_payment",
      );
      expect(released).toEqual([]);
      expect((await sweep(deadline + 1_000)).failed).toBe(0);
      expect(
        (
          await fixture.observer.query(
            "SELECT lifecycle_status FROM booking.guest_bookings WHERE id=$1",
            [pending.bookingId],
          )
        ).rows[0].lifecycle_status,
      ).toBe("expired");
      expect(released).toHaveLength(1);
      const emails = (
        await fixture.observer.query(
          "SELECT job_type FROM platform.jobs WHERE property_id=$1 AND job_type LIKE '%expired' ORDER BY 1",
          [fixture.propertyId],
        )
      ).rows.map((row) => row.job_type);
      expect(emails).toEqual(["email.booking-expired", "email.booking-host-payment-expired"]);
      // A retry of the guest's booking now is a conflict, not a confirmation.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
          bankTransfers: bank,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await store.close();
      await sweepPool.end().catch(() => undefined);
      await bank.close();
      await fixture.close();
    }
  });

  it("confirms a PayPal booking only when the hotel marks it paid before its deadline", async () => {
    const fixture = await setupFixture(manualQuote("paypal", "request"), undefined, true);
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    const command = (bookingId: string): PmsBookingLifecycleCommand => ({
      propertyId: fixture.propertyId,
      guestBookingId: bookingId,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      audit: {
        actor: { kind: "system", service: "apps/api" },
        requestId: randomUUID(),
        reason: "Payment received",
        requestedAt: new Date().toISOString(),
      },
    });
    const deadline = (bookingId: string, interval: string) =>
      fixture.observer.query(
        `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{pendingExpiresAt}',to_jsonb((clock_timestamp()+$2::interval)::text)) WHERE id=$1`,
        [bookingId, interval],
      );
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "paypal", { paypalEmail: "pay@writer.example.test" });
      const pending = await writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
        paypal: true,
      });
      const refused = { ok: false, code: "invalid_status_transition" };
      const reservations = createTargetPmsOperationsReadRepository({
        connectionString: url!,
        pool: pmsPool,
      });
      const flag = async () =>
        (await reservations.findReservationByGuestBookingId(fixture.propertyId, pending.bookingId))
          ?.awaitingHotelPaymentConfirmation;
      expect(await flag()).toBe(true);
      // The request-mode accept step does not apply: the hotel confirms the payment instead.
      await expect(pms.acceptBooking(command(pending.bookingId))).resolves.toMatchObject(refused);
      await deadline(pending.bookingId, "-1 minute");
      await expect(pms.markBookingPaid(command(pending.bookingId))).resolves.toMatchObject(refused);
      await deadline(pending.bookingId, "1 hour");
      await expect(pms.markBookingPaid(command(pending.bookingId))).resolves.toMatchObject({
        ok: true,
      });
      expect(await flag()).toBeUndefined();
      // Keep the shared adoption worker from claiming this fixture's job before cleanup.
      await fixture.observer.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.balance_amount::text AS balance,
            s.lifecycle_status AS summary,s.payment_status AS summary_payment,
            ARRAY(SELECT event_type FROM booking.booking_status_events
              WHERE guest_booking_id=b.id ORDER BY event_type) AS events,
            (SELECT jsonb_build_object('kind',payment_kind,'method',payment_method,'status',status,
              'amount',amount::text) FROM finance.payments WHERE guest_booking_id=b.id) AS payment
           FROM booking.guest_bookings b JOIN booking.direct_booking_summary_read_model s
             ON s.guest_booking_id=b.id WHERE b.id=$1`,
          [pending.bookingId],
        )
      ).rows[0];
      expect(state).toEqual({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        balance: "0.00",
        summary: "confirmed",
        summary_payment: "paid",
        events: [
          "guest_booking.accepted",
          "guest_booking.created",
          "guest_booking.payment_received",
        ],
        payment: {
          kind: "manual",
          method: "paypal",
          status: "paid",
          amount: expect.stringMatching(/^\d+\.\d{2}$/),
        },
      });
      const nights = fixture.f.current.quote.rooms.reduce((n, r) => n + r.nights.length, 0);
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        revenue: nights,
        available: 2,
        assigned: 1,
      });
      const jobs = (
        await fixture.observer.query(
          `SELECT job_type,payload->>'recipientRole' AS role FROM platform.jobs WHERE property_id=$1`,
          [fixture.propertyId],
        )
      ).rows;
      expect(jobs).toContainEqual({ job_type: "email.booking-final-confirmation", role: "guest" });
      expect(jobs).toContainEqual({ job_type: "email.booking-host-new-booking", role: "host" });
      expect(jobs).toContainEqual({
        job_type: "pms.reservation.accepted-pricing.create",
        role: null,
      });
      await expect(pms.markBookingPaid(command(pending.bookingId))).resolves.toMatchObject(refused);
      await expect(snapshot(fixture.observer, fixture)).resolves.toMatchObject({
        revenue: nights,
        jobs: jobs.length,
      });
    } finally {
      await pmsPool.end();
      await fixture.close();
    }
  });

  it("confirms a bank transfer when the hotel marks it paid, with Finance's commission", async () => {
    const fixture = await setupFixture(manualQuote("bank_transfer", "instant"), undefined, true);
    const bank = bankOperations();
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    try {
      // A commission plan (the fixture's plan is fixed, which takes no commission).
      Object.assign(fixture.f.finance, { billingPlanSnapshot: "commission" });
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "bank_transfer");
      const pending = await writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
        bankTransfers: bank,
      });
      const token = await issueTargetBookingConfirmationToken(
        fixture.observer,
        { guestBookingId: pending.bookingId, propertyId: fixture.propertyId },
        new Date(),
      );
      const reveal = () =>
        bank.confirmation({
          propertyId: fixture.propertyId,
          bookingId: pending.bookingId,
          tokenHash: createHash("sha256").update(token.token).digest("hex"),
        });
      await expect(reveal()).resolves.toContain("IBAN");
      const command: PmsBookingLifecycleCommand = {
        propertyId: fixture.propertyId,
        guestBookingId: pending.bookingId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        audit: {
          actor: { kind: "system", service: "apps/api" },
          requestId: randomUUID(),
          reason: "Bank transfer received",
          requestedAt: new Date().toISOString(),
        },
      };
      await expect(pms.markBookingPaid(command)).resolves.toMatchObject({ ok: true });
      await fixture.observer.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      const state = (
        await fixture.observer.query(
          `SELECT b.lifecycle_status,b.payment_status,b.expected_payment_method,
            p.payment_kind,p.payment_method,p.status,p.amount::text,p.fee_amount::text,p.net_amount::text
           FROM booking.guest_bookings b JOIN finance.payments p ON p.guest_booking_id=b.id
           WHERE b.id=$1`,
          [pending.bookingId],
        )
      ).rows;
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({
        lifecycle_status: "confirmed",
        payment_status: "paid",
        expected_payment_method: "bank_transfer",
        payment_kind: "manual",
        payment_method: "bank_transfer",
        status: "paid",
      });
      // The booking engine's 5% commission from the booking's terms; the rest goes to the hotel.
      const cents = (v: string) => Math.round(Number(v) * 100);
      expect(cents(state[0].fee_amount)).toBe(Math.round(cents(state[0].amount) * 0.05));
      expect(cents(state[0].fee_amount)).toBeGreaterThan(0);
      expect(cents(state[0].net_amount)).toBe(cents(state[0].amount) - cents(state[0].fee_amount));
      // Paid: the bank details are no longer shown.
      await expect(reveal()).resolves.toBeNull();
    } finally {
      await pmsPool.end();
      await bank.close();
      await fixture.close();
    }
  });

  /** VAY-2348: an unpaid bank transfer with a hotel PMS and a sweep that only counts releases. */
  async function pendingBankTransfer() {
    const fixture = await setupFixture(manualQuote("bank_transfer", "instant"), undefined, true);
    const bank = bankOperations();
    const pmsPool = new pg.Pool({ connectionString: url, max: 2 });
    const sweepPool = new pg.Pool({ connectionString: url, max: 2 });
    const released: unknown[] = [];
    const store = createPgBookingLifecycleStore({
      connectionString: url!,
      pool: sweepPool,
      inventoryReservationPort: {
        reserve: async () => null,
        async release({ reservation }) {
          released.push(reservation);
        },
      },
    });
    const pms = createTargetPmsOperationsCommandRepository({
      connectionString: url!,
      pool: pmsPool,
      readRepository: {
        findReservationByGuestBookingId: async () => ({}),
      } as unknown as PmsOperationsReadRepository,
    });
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
      new Date().toISOString(),
    );
    await finance(fixture, "bank_transfer");
    const pending = await writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
      bankTransfers: bank,
    });
    if (pending.kind !== "payment_pending" || !("acceptedAt" in pending))
      throw new Error(`unexpected ${pending.kind}`);
    const deadline = Date.parse(pending.payment.deadlineAt);
    return {
      fixture,
      pending,
      deadline,
      released,
      sweepPool,
      /** The sweep just after the deadline; this booking's applied expiries. */
      sweep: async () =>
        (
          await runBookingLifecycleSchedulerJobs(store, {
            now: new Date(deadline + 1_000),
            run: ["pendingBookingExpiry"],
          })
        ).runs
          .flatMap((run) => run.mutations)
          .filter((m) => m.guestBookingId === pending.bookingId && m.applied).length,
      markPaid: () =>
        pms.markBookingPaid({
          propertyId: fixture.propertyId,
          guestBookingId: pending.bookingId,
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          audit: {
            actor: { kind: "system", service: "apps/api" },
            requestId: randomUUID(),
            reason: "Bank transfer received",
            requestedAt: new Date().toISOString(),
          },
        }),
      state: async () =>
        (
          await fixture.observer.query(
            `SELECT b.lifecycle_status AS status,b.payment_status AS payment,
              (SELECT count(*)::int FROM finance.payments p WHERE p.guest_booking_id=b.id) AS payments,
              (SELECT count(*)::int FROM booking.booking_status_events e WHERE e.guest_booking_id=b.id
                AND e.event_type IN ('guest_booking.expired','guest_booking.payment_received')) AS endings
             FROM booking.guest_bookings b WHERE b.id=$1`,
            [pending.bookingId],
          )
        ).rows[0],
      close: async () => {
        await store.close();
        await sweepPool.end().catch(() => undefined);
        await pmsPool.end();
        await bank.close();
        await fixture.close();
      },
    };
  }

  it("never both confirms and releases a bank transfer: paid first, swept first, or at once (VAY-2348)", async () => {
    // Paid before the sweep: the sweep leaves it confirmed and the rooms held.
    const paidFirst = await pendingBankTransfer();
    try {
      await expect(paidFirst.markPaid()).resolves.toMatchObject({ ok: true });
      await expect(paidFirst.sweep()).resolves.toBe(0);
      await expect(paidFirst.state()).resolves.toEqual({
        status: "confirmed",
        payment: "paid",
        payments: 1,
        endings: 1,
      });
      expect(paidFirst.released).toEqual([]);
    } finally {
      await paidFirst.close();
    }
    // Released first: the hotel can no longer mark it paid (D5), nothing is recorded.
    const sweptFirst = await pendingBankTransfer();
    try {
      await expect(sweptFirst.sweep()).resolves.toBe(1);
      await expect(sweptFirst.markPaid()).resolves.toMatchObject({ ok: false });
      await expect(sweptFirst.sweep()).resolves.toBe(0);
      await expect(sweptFirst.state()).resolves.toEqual({
        status: "expired",
        payment: "unpaid",
        payments: 0,
        endings: 1,
      });
      expect(sweptFirst.released).toHaveLength(1);
    } finally {
      await sweptFirst.close();
    }
    // At the same moment: a held row lock makes both wait, then exactly one of them wins.
    const racing = await pendingBankTransfer();
    const lockPool = new pg.Pool({ connectionString: url, max: 2 });
    const blocker = await lockPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM booking.guest_bookings WHERE id=$1 FOR UPDATE", [
        racing.pending.bookingId,
      ]);
      const holder = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const both = Promise.all([racing.markPaid(), racing.sweep()]);
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting < 2; attempt++) {
        waiting =
          // The second waiter queues behind the first, so count every lock wait in this database.
          (
            await lockPool.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
              [holder],
            )
          ).rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
      await blocker.query("COMMIT");
      const [paid, expired] = await both;
      const state = await racing.state();
      if (paid.ok) {
        expect(expired).toBe(0);
        expect(state).toEqual({ status: "confirmed", payment: "paid", payments: 1, endings: 1 });
        expect(racing.released).toEqual([]);
      } else {
        expect(expired).toBe(1);
        expect(state).toEqual({ status: "expired", payment: "unpaid", payments: 0, endings: 1 });
        expect(racing.released).toHaveLength(1);
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await lockPool.end();
      await racing.close();
    }
  }, 60_000);

  it("reminds the guest once a day before the bank transfer deadline, never after it ends (VAY-2348)", async () => {
    const reminders = async (booking: Awaited<ReturnType<typeof pendingBankTransfer>>) =>
      (
        await booking.fixture.observer.query(
          `SELECT payload->>'recipientRole' AS role,
            (payload->>'requiresBankTransferInstructions')::boolean AS bank,
            payload->>'paymentDeadlineAt' AS deadline
           FROM platform.jobs WHERE resource_id=$1 AND job_type='email.booking-payment-reminder'`,
          [booking.pending.bookingId],
        )
      ).rows;
    const remind = (
      booking: Awaited<ReturnType<typeof pendingBankTransfer>>,
      hoursBeforeDeadline: number,
    ) =>
      runBankTransferPaymentReminders(booking.sweepPool, {
        now: new Date(booking.deadline - hoursBeforeDeadline * 3_600_000),
      });
    const waiting = await pendingBankTransfer();
    try {
      // Booked just now: the reminder waits until 24 hours before the deadline.
      await remind(waiting, 25);
      expect(await reminders(waiting)).toEqual([]);
      // Two runs (two servers) race the first reminder: one is queued.
      await Promise.all([remind(waiting, 23), remind(waiting, 23)]);
      const once = [{ role: "guest", bank: true, deadline: waiting.pending.payment.deadlineAt }];
      expect(await reminders(waiting)).toEqual(once);
      // Later runs: still one.
      await remind(waiting, 22);
      expect(await reminders(waiting)).toEqual(once);
    } finally {
      await waiting.close();
    }
    // Paid or released bookings get no reminder.
    const paid = await pendingBankTransfer();
    try {
      await expect(paid.markPaid()).resolves.toMatchObject({ ok: true });
      await remind(paid, 23);
      expect(await reminders(paid)).toEqual([]);
    } finally {
      await paid.close();
    }
    const released = await pendingBankTransfer();
    try {
      // Less than 2 hours left (after downtime, say): too late to be of use.
      await remind(released, 1);
      expect(await reminders(released)).toEqual([]);
      await expect(released.sweep()).resolves.toBe(1);
      await remind(released, 23);
      expect(await reminders(released)).toEqual([]);
    } finally {
      await released.close();
    }
  }, 60_000);

  it("lets the hotel decline an unpaid PayPal booking: rooms released, guest told", async () => {
    const fixture = await setupFixture(manualQuote("paypal", "instant"), undefined, true);
    const hostPool = new pg.Pool({ connectionString: url, max: 2 });
    const released: unknown[] = [];
    const actions = createBookingHostActions({
      pool: hostPool,
      guards: targetBookingHostActionGuards,
      inventory: {
        reserve: async () => null,
        async release({ reservation }) {
          released.push(reservation);
        },
      },
    });
    const actorUserId = randomUUID();
    try {
      mockOwners(fixture);
      vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async () =>
        new Date().toISOString(),
      );
      await finance(fixture, "paypal", { paypalEmail: "pay@writer.example.test" });
      const pending = await writePricingAcceptance(fixture.pool, fixture.input, undefined, false, {
        paypal: true,
      });
      await fixture.observer.query(
        "INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')",
        [actorUserId, `${actorUserId}@example.test`],
      );
      const scope = { propertyId: fixture.propertyId, bookingId: pending.bookingId, actorUserId };
      const preview = await actions.preview(scope, { action: "reject", reason: "No payment" });
      await expect(actions.apply(scope, preview.previewId, "decline")).resolves.toEqual({
        bookingId: pending.bookingId,
        lifecycleStatus: "declined",
      });
      expect(released).toHaveLength(1);
      const jobs = (
        await fixture.observer.query("SELECT job_type FROM platform.jobs WHERE property_id=$1", [
          fixture.propertyId,
        ])
      ).rows.map((row) => row.job_type);
      expect(jobs).toContain("email.booking-rejected");
      expect(jobs.filter((job) => job.startsWith("pms."))).toEqual([]);
      // A retry of the guest's booking is now a conflict, not a confirmation.
      await expect(
        writePricingAcceptance(fixture.pool, fixture.input, undefined, false, { paypal: true }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await actions.close();
      await hostPool.end().catch(() => undefined);
      await fixture.close();
    }
  });
});

async function setupFixture(
  changeQuote?: (quote: Fixture["f"]["current"]["quote"]) => void,
  currency?: string,
  /** Move the stay to 10 days from today (or that many days): bank-transfer and PayPal need the
   * hotel's time zone and a check-in further away than their deadline (VAY-2145). */
  futureStay: boolean | number = false,
) {
  if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
    throw new Error("test database required");
  const rawPool = new pg.Pool({ connectionString: url, max: 3 });
  const writerPids: number[] = [];
  const pool = {
    connect: async () => {
      const client = await rawPool.connect();
      writerPids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      return client;
    },
  };
  const observer = await rawPool.connect();
  const propertyId = randomUUID(),
    organizationId = randomUUID(),
    roomTypeId = randomUUID();
  const now = new Date();
  let charges!: NonNullable<ReturnType<typeof calculateReplacementFixedCharges>> & {
    sourceRevision: string;
  };
  const f = pricingDraftFixture((quote) => {
    if (currency) inCurrency(quote, currency);
    if (futureStay) {
      const day = (offset: number) =>
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
          .toISOString()
          .slice(0, 10);
      const nights = quote.rooms[0].nights.length;
      const offset = futureStay === true ? 10 : futureStay;
      Object.assign(quote.stay, { checkIn: day(offset), checkOut: day(offset + nights) });
      for (const room of quote.rooms)
        room.nights.forEach((night, index) => Object.assign(night, { date: day(offset + index) }));
    }
    Object.assign(quote, { quoteId: randomUUID() });
    Object.assign(quote.stay, { propertyId });
    Object.assign(quote.stay.rooms[0], { roomTypeId });
    Object.assign(quote.evidence, {
      requestKey: replacementStayKey(quote.stay),
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });
    Object.assign(quote.evidence.terms[0], { roomTypeId });
    charges = {
      ...calculateReplacementFixedCharges(quote.stay, {
        version: "booking.fixed-charges.v1",
        currency: quote.stay.currency,
        charges: [],
      })!,
      sourceRevision: quote.evidence.revisions.charges,
    };
    Object.assign(quote.evidence, { mandatoryChargeEvidenceId: charges.basisEvidenceId });
    changeQuote?.(quote);
  });
  Object.assign(f.current.scope, { propertyId, organizationId });
  Object.assign(f.finance.scope, { propertyId, organizationId });
  Object.assign(f.finance, {
    financeTermsCapturedAt: new Date(now.getTime() - 30_000).toISOString(),
    validUntil: new Date(now.getTime() + 600_000).toISOString(),
  });
  Object.assign(f.finance.commissionTermsSnapshot, {
    financeConfigUpdatedAt: new Date(now.getTime() - 60_000).toISOString(),
  });
  const quote = f.current.quote;
  Object.assign(f.current, {
    calculation: {
      addons: {
        kind: "addon_components",
        evaluatorVersion: "booking.addon-components.v2",
        sourceRevision: quote.evidence.revisions.addons,
        requestKey: replacementStayKey(quote.stay),
        currency: quote.stay.currency,
        totalMinor: "0",
        lines: [],
      },
      charges,
    },
  });
  await observer.query("BEGIN");
  await observer.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Writer test',($1::uuid)::text)",
    [organizationId],
  );
  await observer.query(
    "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,($1::uuid)::text,'Writer test')",
    [propertyId],
  );
  if (futureStay)
    await observer.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Rome')",
      [propertyId],
    );
  await observer.query(
    `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits,base_rate_amount,currency)
     VALUES($1,$2,'Writer room','{"adults":2,"children":1,"total":3}',100,$3)`,
    [roomTypeId, propertyId, f.current.quote.stay.currency],
  );
  // This row is a transaction sentinel for the already-tested inventory owner.
  await observer.query("SET LOCAL session_replication_role=replica");
  await observer.query(
    `INSERT INTO pms.inventory_days
      (property_id,room_type_id,stay_date,total_count,available_count,assigned_count,
       calendar_revision,inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
       generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
     VALUES($1,$2,$3,3,3,0,1,1,3,3,1,0,0,0,0)`,
    [propertyId, roomTypeId, quote.stay.checkIn],
  );
  await observer.query("SET LOCAL session_replication_role=origin");
  await observer.query(
    `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      quote.quoteId,
      propertyId,
      organizationId,
      f.command.requestId,
      hash(f.command.requestId),
      { quote, calculation: { ...f.current.calculation, version: "booking.quote-calculation.v1" } },
    ],
  );
  await observer.query("COMMIT");
  const { fingerprint: _fingerprint, ...command } = f.command;
  const input = {
    slug: "writer-test",
    command,
  };
  return {
    pool,
    observer,
    propertyId,
    organizationId,
    roomTypeId,
    writerPids,
    f,
    input,
    close: async () => {
      await observer.query("BEGIN");
      await observer.query("SET LOCAL session_replication_role=replica");
      await observer.query(
        `DELETE FROM platform.job_attempts WHERE job_id IN
          (SELECT id FROM platform.jobs WHERE property_id=$1)`,
        [propertyId],
      );
      const tables = (
        await observer.query(
          `SELECT c.table_schema,c.table_name FROM information_schema.columns c
           JOIN information_schema.tables table_info USING(table_schema,table_name)
           WHERE c.column_name='property_id' AND table_info.table_type='BASE TABLE'
             AND c.table_schema IN
             ('booking','distribution','finance','hotel_catalog','identity','platform','pms')
           ORDER BY c.table_schema,c.table_name`,
        )
      ).rows as { table_schema: string; table_name: string }[];
      for (const { table_schema: schema, table_name: table } of tables) {
        if (!/^[a-z_]+$/.test(schema) || !/^[a-z_]+$/.test(table)) continue;
        await observer.query(`DELETE FROM "${schema}"."${table}" WHERE property_id::text=$1`, [
          propertyId,
        ]);
      }
      await observer.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await observer.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      await observer.query("COMMIT");
      observer.release();
      await rawPool.end();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

function mockOwners(fixture: Fixture) {
  const { f, propertyId, roomTypeId } = fixture;
  expect(
    parseBookingQuoteAcceptanceInput(fixture.input.command, f.current.quote, f.disclosure.policy),
  ).toEqual(f.command);
  expect(
    pricingRoomRevenueProjection(f.current.quote, f.current.calculation?.charges),
  ).not.toBeNull();
  vi.mocked(lockPublicPricingAuthority).mockImplementation(async (client) => {
    await lockPmsInventoryMutationScope(client, propertyId);
    return f.current.scope;
  });
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(f.current);
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(f.disclosure);
  vi.mocked(lockFinancePricingAcceptanceTerms).mockResolvedValue(f.finance);
  vi.mocked(reserveRevalidatedQuoteInventory).mockImplementation(async (client) => {
    const changed = await client.query(
      `UPDATE pms.inventory_days SET available_count=available_count-1,assigned_count=assigned_count+1,
       inventory_revision=inventory_revision+1,booking_source_revision=booking_source_revision+1
       WHERE property_id=$1 AND room_type_id=$2 AND stay_date=$3 AND available_count>0 RETURNING 1`,
      [propertyId, roomTypeId, f.current.quote.stay.checkIn],
    );
    if (changed.rowCount !== 1) throw new Error("Quote inventory is unavailable");
    return {
      quote: f.current.quote,
      bundle: parsePmsInventoryReservationBundle(acceptanceFixture().inventory_reservation_bundle)!,
      replayed: false,
    };
  });
}

async function snapshot(client: PoolClient, fixture: Fixture) {
  const row = (
    await client.query(
      `SELECT
       (SELECT count(*)::int FROM booking.guest_bookings WHERE property_id=$1::uuid) AS bookings,
       (SELECT count(*)::int FROM booking.pricing_quote_acceptances WHERE property_id=$1::uuid) AS acceptances,
       (SELECT count(*)::int FROM platform.jobs WHERE property_id=$1::uuid) AS jobs,
       (SELECT count(*)::int FROM booking.nightly_revenue_evidence revenue
          JOIN booking.guest_bookings booking ON booking.id=revenue.guest_booking_id
         WHERE booking.property_id=$1::uuid) AS revenue,
       available_count::int AS available,assigned_count::int AS assigned
       FROM pms.inventory_days WHERE property_id=$2 AND room_type_id=$3 AND stay_date=$4`,
      [
        fixture.propertyId,
        fixture.propertyId,
        fixture.roomTypeId,
        fixture.f.current.quote.stay.checkIn,
      ],
    )
  ).rows[0];
  return row;
}

async function waitForSecondWriter(fixture: Fixture) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.writerPids[1]) return fixture.writerPids[1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("second writer did not connect");
}

async function isBlocked(client: PoolClient, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = (
      await client.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])
    ).rows[0].blocked;
    if (blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
