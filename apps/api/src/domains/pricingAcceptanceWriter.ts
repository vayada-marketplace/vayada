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
  pricingCardBookingId,
  readPricingCardReplay,
  startPricingCardPayment,
} from "./pricingCardPayment.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { authorizePricingCardRequest } from "./pricingCardPaymentCompletion.js";

export class PricingAcceptanceError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "storage"
      | "unexpected"
      | "card_unavailable"
      | "request_unavailable",
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
  /** Request-mode pay-at-property quotes (REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED). */
  requests = false,
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
      request: requests,
    });
    if (prepared.kind === "replayed") {
      // A card acceptance that still awaits payment answers with the same payment; an
      // expired one is a conflict, never the plain "accepted" replay.
      const card = await readPricingCardReplay(
        client,
        cardPayments?.provider,
        input.slug,
        prepared,
      );
      if (card?.kind === "authorize") {
        await authorizePricingCardRequest(client, card.propertyId, {
          paymentIntentId: card.paymentIntentId,
          amountMinor: card.amountMinor,
          currency: card.currency,
        });
        await client.query("COMMIT");
        return prepared;
      }
      await client.query("COMMIT");
      return card || prepared;
    }
    const bookingId =
      cardPayments && pricingCardQuoteSupported(prepared.current.quote)
        ? pricingCardBookingId(prepared.current.scope.propertyId, prepared.command.requestId)
        : randomUUID();
    const publicReference = `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`;
    await stagePricingBookingDraft(client, input.slug, {
      ...prepared,
      bookingId,
      publicReference,
      syntheticAffiliateContextId: internal?.syntheticAffiliateContextId,
      affiliateContextId: internal?.affiliateContextId,
    });
    const lifecycle = await stagePricingBookingLifecycle(
      client,
      input.slug,
      prepared.current,
      bookingId,
    );
    if (cardPayments && pricingCardQuoteSupported(prepared.current.quote)) {
      // Card: the quote is accepted now, while it is valid, and the rooms stay held with the
      // booking `pending_payment`. Revenue, notifications and the PMS job follow the
      // confirmed Stripe payment.
      const accepted = await storePricingAcceptance(client, input.slug, prepared, lifecycle, null);
      const intent = await startPricingCardPayment(client, cardPayments.provider, {
        slug: input.slug,
        current: prepared.current,
        finance: prepared.finance,
        bookingId,
        publicReference,
        requestId: prepared.command.requestId,
        occurredAt: lifecycle.occurredAt,
      });
      await finishPricingAcceptance(client, input.slug, prepared.current, prepared.finance);
      await client.query("COMMIT");
      return {
        kind: "payment_required" as const,
        ...accepted,
        bookingReference: publicReference,
        payment: {
          provider: "stripe" as const,
          clientSecret: intent.clientSecret,
          stripeAccountId: intent.providerAccountRef,
          paymentIntentId: intent.paymentIntentId,
          expiresAt: lifecycle.paymentDeadlineAt,
        },
      };
    }
    if (prepared.current.quote.acceptanceMode === "request") {
      // Request: the rooms stay held with the booking `pending_payment` until the hotel
      // answers. Revenue and the PMS job follow its acceptance; decline or expiry release.
      const accepted = await storePricingAcceptance(client, input.slug, prepared, lifecycle, null);
      await stagePricingAcceptanceNotifications(client, input.slug, accepted);
      const checkedAt = await finishPricingAcceptance(
        client,
        input.slug,
        prepared.current,
        prepared.finance,
      );
      await client.query("COMMIT");
      return {
        kind: "requested" as const,
        ...accepted,
        bookingReference: publicReference,
        hostResponseDeadlineAt: lifecycle.hostResponseDeadlineAt,
        checkedAt,
      };
    }
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
    if (error instanceof Error && error.message === "Card acceptance unavailable")
      throw new PricingAcceptanceError("card_unavailable", error);
    if (error instanceof Error && error.message === "Request acceptance unavailable")
      throw new PricingAcceptanceError("request_unavailable", error);
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
