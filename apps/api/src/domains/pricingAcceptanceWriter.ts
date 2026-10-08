import { randomUUID } from "node:crypto";
import type pg from "pg";
import { finishPricingAcceptance } from "./finishPricingAcceptance.js";
import { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import { stagePricingAcceptanceNotifications } from "./pricingAcceptanceNotifications.js";
import { stagePricingBookingDraft } from "./pricingBookingDraft.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { stagePricingBookingRevenue } from "./pricingBookingRevenue.js";
import { stagePmsAcceptedPricingReservationJob } from "./pricingPmsAcceptedReservationJob.js";
import { storePricingAcceptance } from "./storePricingAcceptance.js";
import {
  pricingCardQuoteSupported,
  stagePricingCardDraftHold,
  startPricingCardPayment,
} from "./pricingCardPayment.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";

export class PricingAcceptanceError extends Error {
  constructor(
    readonly code: "conflict" | "storage" | "unexpected",
    cause: unknown,
  ) {
    super("Pricing acceptance failed", { cause });
  }
}

const conflictMessages = new Set([
  "Booking acceptance unavailable",
  "Booking acceptance expired or unavailable",
  "Booking notifications unavailable",
  "PMS accepted-pricing job conflict",
  "PMS accepted-pricing job unavailable",
  "Pricing booking draft is unavailable",
  "Pricing booking lifecycle is unavailable",
  "Pricing booking revenue is unavailable",
  "Pricing card payment is unavailable",
]);

export async function writePricingAcceptance(
  pool: Pick<pg.Pool, "connect">,
  input: {
    slug: unknown;
    command: unknown;
  },
  internal?:
    | { syntheticAffiliateContextId: string; affiliateContextId?: never }
    | { affiliateContextId: string; syntheticAffiliateContextId?: never },
  /** Card quotes are accepted only with a payment provider (REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED). */
  cardPayments?: { provider: StripeBookingPaymentProvider },
) {
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new PricingAcceptanceError("storage", error);
  }
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const prepared = await preparePricingAcceptance(client, input.slug, input.command, {
      card: cardPayments !== undefined,
    });
    if (prepared.kind === "replayed") {
      await client.query("COMMIT");
      return prepared;
    }
    const bookingId = randomUUID();
    const publicReference = `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`;
    await stagePricingBookingDraft(client, input.slug, {
      ...prepared,
      bookingId,
      publicReference,
      syntheticAffiliateContextId: internal?.syntheticAffiliateContextId,
      affiliateContextId: internal?.affiliateContextId,
    });
    if (cardPayments && pricingCardQuoteSupported(prepared.current.quote)) {
      // Card: hold the rooms and start the payment. Confirmation, revenue, notifications,
      // the PMS job and the acceptance row follow once Stripe reports the payment; the
      // command receipt stays in progress until then.
      const hold = await stagePricingCardDraftHold(client, input.slug, prepared.current, bookingId);
      const intent = await startPricingCardPayment(client, cardPayments.provider, {
        slug: input.slug,
        current: prepared.current,
        finance: prepared.finance,
        bookingId,
        publicReference,
        requestId: prepared.command.requestId,
        occurredAt: hold.occurredAt,
      });
      await finishPricingAcceptance(client, input.slug, prepared.current, prepared.finance);
      await client.query("COMMIT");
      return {
        kind: "payment_required" as const,
        bookingId,
        bookingReference: publicReference,
        payment: {
          provider: "stripe" as const,
          clientSecret: intent.clientSecret,
          stripeAccountId: intent.providerAccountRef,
          paymentIntentId: intent.paymentIntentId,
          expiresAt: hold.draftExpiresAt,
        },
      };
    }
    const lifecycle = await stagePricingBookingLifecycle(
      client,
      input.slug,
      prepared.current,
      bookingId,
    );
    const revenue = await stagePricingBookingRevenue(
      client,
      input.slug,
      prepared.current,
      lifecycle,
    );
    const accepted = await storePricingAcceptance(client, input.slug, prepared, lifecycle, revenue);
    await stagePricingAcceptanceNotifications(client, input.slug, accepted);
    await stagePmsAcceptedPricingReservationJob(client, input.slug, accepted);
    const checkedAt = await finishPricingAcceptance(
      client,
      input.slug,
      prepared.current,
      prepared.finance,
    );
    await client.query("COMMIT");
    return {
      kind: "accepted" as const,
      ...accepted,
      bookingReference: publicReference,
      checkedAt,
    };
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PricingAcceptanceError) throw error;
    if (error instanceof Error && conflictMessages.has(error.message))
      throw new PricingAcceptanceError("conflict", error);
    if (
      error !== null &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
    )
      throw new PricingAcceptanceError("storage", error);
    throw new PricingAcceptanceError("unexpected", error);
  } finally {
    client?.release();
  }
}
