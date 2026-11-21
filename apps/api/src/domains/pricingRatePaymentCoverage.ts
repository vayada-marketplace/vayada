import type { PricingPaymentMethod } from "@vayada/domain-booking";
import { pricingOfferOnBookingPage } from "@vayada/domain-pms";
import type pg from "pg";
import { lockBookingPricingOfferTerms } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import {
  pricingPaymentsNow,
  pricingRatePaymentMethods,
  type PricingPaymentSwitches,
} from "./pricingRatePayability.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

/** One booking-page rate and how guests could pay for it (VAY-2583). */
export type RatePaymentCoverageRate = Readonly<{
  roomTypeId: string;
  roomName: string;
  offerId: string;
  /** The rate as the hotel knows it: its cancellation kind (Flexible or Non-refundable). */
  cancellation: "flexible" | "non_refundable";
  /** The ways to pay the rate's own terms accept. */
  acceptedMethods: readonly PricingPaymentMethod[];
  /** Those guests could pay with: accepted by the rate and ready at the hotel. */
  payableWith: readonly PricingPaymentMethod[];
}>;

export type RatePaymentCoverage = Readonly<{
  rates: readonly RatePaymentCoverageRate[];
  /** How many rates guests could pay for. */
  payable: number;
}>;

/** A payment-settings change to judge before it is saved. */
export type ProposedPaymentSettings = Readonly<{
  paymentsEnabled: boolean;
  acceptedMethods: readonly string[];
}>;

/** VAY-2583: the hotel's published booking-page rates and which of them guests could pay for,
 * with its payment settings now or as `proposed` would leave them. A rate sells only by the ways
 * its own terms accept that are ready at the hotel (pricingRatePaymentMethods), with the booking
 * page's switches; card counts only when Finance's card readiness says so. Null: nothing
 * published. Read-only, inside the caller's transaction. */
export async function readRatePaymentCoverage(
  client: pg.PoolClient,
  propertyId: string,
  switches: PricingPaymentSwitches,
  proposed?: ProposedPaymentSettings,
): Promise<RatePaymentCoverage | null> {
  const stored = await readCurrentPricingSnapshot(client, propertyId);
  if (!stored) return null;
  const references = stored.rooms.flatMap((room) =>
    room.offers.filter(pricingOfferOnBookingPage).map((offer) => ({
      roomTypeId: room.roomTypeId,
      offerId: offer.id,
      revision: offer.termsRevision,
    })),
  );
  if (!references.length) return null;
  const terms = await lockBookingPricingOfferTerms(client, propertyId, references);
  if (!terms) return null;
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId,
    currency: stored.currency,
    pricingRevision: stored.revision,
    terms,
    ...(proposed && { proposed }),
  });
  const now = pricingPaymentsNow(finance.kind === "ready" ? finance.methods : [], switches);
  const names = new Map(
    (
      await client.query<{ id: string; name: string }>(
        "SELECT id::text, name FROM pms.room_types WHERE property_id = $1",
        [propertyId],
      )
    ).rows.map((row) => [row.id.toLowerCase(), row.name]),
  );
  const rates = terms.map((rate) => ({
    roomTypeId: rate.roomTypeId,
    roomName: names.get(rate.roomTypeId.toLowerCase()) ?? "",
    offerId: rate.offerId,
    cancellation:
      rate.cancellation.kind === "non_refundable"
        ? ("non_refundable" as const)
        : ("flexible" as const),
    acceptedMethods: [...(rate.payment.acceptedMethods ?? [])],
    payableWith: pricingRatePaymentMethods(rate, now),
  }));
  return { rates, payable: rates.filter((rate) => rate.payableWith.length > 0).length };
}

/** The coverage on a transaction of its own that only reads and is always rolled back (its terms
 * and finance reads take share locks, which a READ ONLY transaction refuses), for Finance's
 * payment settings (VAY-2583). */
export function createRatePaymentCoverage(
  pool: Pick<pg.Pool, "connect">,
  switches: PricingPaymentSwitches,
) {
  return async (
    propertyId: string,
    proposed?: ProposedPaymentSettings,
  ): Promise<RatePaymentCoverage | null> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '5s'");
      return await readRatePaymentCoverage(client, propertyId, switches, proposed);
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  };
}
