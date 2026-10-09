import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { writePricingAcceptance } from "./pricingAcceptanceWriter.js";
import {
  completePricingCardPayment,
  expirePricingCardBooking,
} from "./pricingCardPaymentCompletion.js";
import { settleStripeBookingPayment } from "./stripeBookingSettlement.js";
import { createStripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { readBookingAffiliateContextForQuote } from "./bookingAffiliateContextForQuote.js";
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
    const affiliateContextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,TRUE)",
      [affiliateContextId, fixture.propertyId],
    );
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
      [affiliateContextId, fixture.propertyId, randomUUID()],
    );
    const internal = { syntheticAffiliateContextId: affiliateContextId };
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

    const write = writePricingAcceptance(fixture.pool, fixture.input, internal);
    await stagedPromise;
    const replay = writePricingAcceptance(fixture.pool, fixture.input, internal);
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
    expect(
      (
        await fixture.observer.query(
          "SELECT context_id,history_cutoff FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [accepted.bookingId],
        )
      ).rows[0],
    ).toEqual({ context_id: affiliateContextId, history_cutoff: "1" });
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,2)`,
      [affiliateContextId, fixture.propertyId, randomUUID()],
    );

    await expect(
      writePricingAcceptance(fixture.pool, fixture.input, internal),
    ).resolves.toMatchObject({
      kind: "replayed",
      bookingId: accepted.bookingId,
    });
    expect(
      (
        await fixture.observer.query(
          "SELECT history_cutoff FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [accepted.bookingId],
        )
      ).rows[0].history_cutoff,
    ).toBe("1");
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

  it("binds a live click admitted while acceptance waits for the context lock", async () => {
    const fixture = await setupFixture();
    const contextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,FALSE)",
      [contextId, fixture.propertyId],
    );
    await fixture.observer.query("BEGIN");
    await fixture.observer.query(
      "SELECT id FROM booking.affiliate_click_contexts WHERE id=$1 FOR UPDATE",
      [contextId],
    );
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
      [contextId, fixture.propertyId, randomUUID()],
    );
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async (client) => {
      await client.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      return new Date().toISOString();
    });
    const writing = writePricingAcceptance(fixture.pool, fixture.input, {
      affiliateContextId: contextId,
    });
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fixture.writerPids[0]) {
        blocked = await isBlocked(fixture.observer, fixture.writerPids[0]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await fixture.observer.query("COMMIT");
    const result = await writing;
    expect(blocked).toBe(true);
    expect(result).toMatchObject({ kind: "accepted" });
    expect(
      (
        await fixture.observer.query(
          "SELECT context_id,history_cutoff,synthetic FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [result.bookingId],
        )
      ).rows[0],
    ).toEqual({ context_id: contextId, history_cutoff: "1", synthetic: false });
    await fixture.close();
  }, 20_000);

  it("does not create a booking binding from an empty live context", async () => {
    const fixture = await setupFixture();
    const contextId = randomUUID();
    await fixture.observer.query(
      "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,FALSE)",
      [contextId, fixture.propertyId],
    );
    mockOwners(fixture);
    await expect(
      writePricingAcceptance(fixture.pool, fixture.input, { affiliateContextId: contextId }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot(fixture.observer, fixture)).toMatchObject({
      bookings: 0,
      acceptances: 0,
    });
    await fixture.close();
  });

  it("ignores an expired live context after the booking writer locks it", async () => {
    const fixture = await setupFixture();
    const staleContextId = randomUUID();
    const freshContextId = randomUUID();
    await fixture.observer.query(
      `INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose,status)
       VALUES($1,'writer-test','canonical','active')`,
      [fixture.propertyId],
    );
    for (const contextId of [staleContextId, freshContextId]) {
      await fixture.observer.query(
        "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,FALSE)",
        [contextId, fixture.propertyId],
      );
    }
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position,admitted_at)
       VALUES($1,$2,$3,1,clock_timestamp()-interval '91 days')`,
      [staleContextId, fixture.propertyId, randomUUID()],
    );
    await fixture.observer.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)`,
      [freshContextId, fixture.propertyId, randomUUID()],
    );
    await expect(
      readBookingAffiliateContextForQuote(fixture.observer, "writer-test", staleContextId),
    ).resolves.toBeNull();
    await expect(
      readBookingAffiliateContextForQuote(fixture.observer, "other-hotel", freshContextId),
    ).resolves.toBeNull();
    await expect(
      readBookingAffiliateContextForQuote(fixture.observer, "writer-test", freshContextId),
    ).resolves.toBe(freshContextId);
    mockOwners(fixture);
    vi.mocked(finishCurrentQuoteAcceptanceTime).mockImplementation(async (client) => {
      await client.query(
        "UPDATE platform.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE queue_name='pms-reservation-handoff' AND property_id=$1",
        [fixture.propertyId],
      );
      return new Date().toISOString();
    });
    const result = await writePricingAcceptance(fixture.pool, fixture.input, {
      affiliateContextId: staleContextId,
    });
    expect(result).toMatchObject({ kind: "accepted" });
    expect(
      (
        await fixture.observer.query(
          "SELECT 1 FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [result.bookingId],
        )
      ).rowCount,
    ).toBe(0);
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

  async function cardFixture(accountRef = "acct_writer_test", currency?: string) {
    const fixture = await setupFixture(cardQuote, currency);
    const slug = `writer-${fixture.propertyId}`;
    fixture.input.slug = slug;
    await fixture.observer.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
      [fixture.propertyId, slug],
    );
    const accountId = randomUUID();
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

  it("accepts the quote, holds the rooms and starts a Stripe payment without confirming", async () => {
    const { fixture, slug, createPaymentIntent, retrievePaymentIntent, provider } =
      await cardFixture();
    try {
      await expect(writePricingAcceptance(fixture.pool, fixture.input)).rejects.toMatchObject({
        code: "card_unavailable",
      });
      expect(createPaymentIntent).not.toHaveBeenCalled();

      const result = await writePricingAcceptance(fixture.pool, fixture.input, undefined, {
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
        writePricingAcceptance(fixture.pool, fixture.input, undefined, { provider }),
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

  // Stripe test mode (VAY-1543 K5). Runs only with STRIPE_TEST_SECRET_KEY (a test-mode key) and
  // STRIPE_TEST_CONNECTED_ACCOUNT; CI has neither, so it never calls Stripe there. Optional
  // STRIPE_TEST_CURRENCY (EUR, USD or IDR) prices the quote in that currency.
  const stripeKey = process.env.STRIPE_TEST_SECRET_KEY;
  const stripeAccount = process.env.STRIPE_TEST_CONNECTED_ACCOUNT;
  const stripeTestMode =
    !!stripeKey && /^(sk|rk)_test_/.test(stripeKey) && !!stripeAccount?.startsWith("acct_");
  const stripeCurrency = process.env.STRIPE_TEST_CURRENCY?.toUpperCase();
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
        const required = (await writePricingAcceptance(fixture.pool, fixture.input, undefined, {
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
          writePricingAcceptance(fixture.pool, fixture.input, undefined, { provider }),
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
  );

  it.skipIf(!stripeTestMode)(
    "Stripe test mode: an unpaid booking expires, Stripe cancels the payment, rooms are released",
    async () => {
      const { fixture } = await cardFixture(stripeAccount!, stripeCurrency);
      const provider = createStripeBookingPaymentProvider({ secretKey: stripeKey! });
      try {
        const required = (await writePricingAcceptance(fixture.pool, fixture.input, undefined, {
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
  );

  it("expires an unpaid card booking at its deadline, releases the rooms and never replays it as accepted", async () => {
    const { fixture, provider, retrievePaymentIntent, cancelPaymentIntent } = await cardFixture();
    try {
      const accepted = (await writePricingAcceptance(fixture.pool, fixture.input, undefined, {
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
        writePricingAcceptance(fixture.pool, fixture.input, undefined, { provider }),
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
      await writePricingAcceptance(fixture.pool, fixture.input, undefined, { provider });
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

      const requested = await writePricingAcceptance(
        fixture.pool,
        fixture.input,
        undefined,
        undefined,
        true,
      );
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
        writePricingAcceptance(fixture.pool, fixture.input, undefined, undefined, true),
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

async function setupFixture(
  changeQuote?: (quote: Fixture["f"]["current"]["quote"]) => void,
  currency?: string,
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
             ('booking','distribution','finance','hotel_catalog','identity','marketplace','platform','pms')
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
