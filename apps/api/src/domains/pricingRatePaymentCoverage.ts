import type { PricingPaymentMethod } from "@vayada/domain-booking";
import { pricingOfferOnBookingPage } from "@vayada/domain-pms";
import type pg from "pg";
import { lockBookingPricingOfferTerms } from "./bookingPricingOfferTerms.js";
import {
  lockFinanceReplacementPricingReadiness,
  type FinanceReplacementPricingReadiness,
} from "./financeReplacementPricingReadiness.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";
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
  /** The hotel's payment settings as saved (not as proposed). */
  settings: Readonly<{ paymentsEnabled: boolean; acceptedMethods: readonly string[] }>;
  /** Why Finance has no way to pay at all (null: it has some, ready). */
  financeReason:
    | Extract<FinanceReplacementPricingReadiness, { kind: "unavailable" }>["reason"]
    | null;
}>;

/** A payment-settings change to judge before it is saved; `paymentsEnabled` unset keeps the
 * saved switch. */
export type ProposedPaymentSettings = Readonly<{
  paymentsEnabled?: boolean;
  acceptedMethods: readonly string[];
}>;

export type RatePaymentCoverageReader = (
  propertyId: string,
  proposed?: ProposedPaymentSettings,
) => Promise<RatePaymentCoverage | null>;

/** VAY-2583: a live booking page's rates and which of them guests could pay for, with the hotel's
 * payment settings now or as `proposed` would leave them. A rate sells only by the ways its own
 * terms accept that are ready at the hotel (pricingRatePaymentMethods), with the booking page's
 * switches, on the rooms the page lists (operating); card counts only when Finance's card
 * readiness says so. Null: the page isn't live, or nothing is published. Read-only, inside the
 * caller's transaction. */
export async function readRatePaymentCoverage(
  client: pg.PoolClient,
  propertyId: string,
  switches: PricingPaymentSwitches,
  proposed?: ProposedPaymentSettings,
): Promise<RatePaymentCoverage | null> {
  const live = await client.query(
    "SELECT 1 FROM distribution.active_public_booking_revision WHERE property_id=$1",
    [propertyId],
  );
  if (!live.rows.length) return null;
  const stored = await readCurrentPricingSnapshot(client, propertyId);
  if (!stored) return null;
  const operating = new Set(
    (await readPmsRoomOperatingEligibility(client, propertyId))
      .filter((room) => room.state === "operating")
      .map((room) => room.roomTypeId.toLowerCase()),
  );
  const references = stored.rooms
    .filter((room) => operating.has(room.roomTypeId.toLowerCase()))
    .flatMap((room) =>
      room.offers.filter(pricingOfferOnBookingPage).map((offer) => ({
        roomTypeId: room.roomTypeId,
        offerId: offer.id,
        revision: offer.termsRevision,
      })),
    );
  if (!references.length) return null;
  const terms = await lockBookingPricingOfferTerms(client, propertyId, references);
  if (!terms) return null;
  const saved = (
    await client.query<{ payments_enabled: boolean; accepted_methods: string[] }>(
      "SELECT payments_enabled, accepted_methods FROM finance.payment_settings WHERE property_id=$1",
      [propertyId],
    )
  ).rows[0];
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId,
    currency: stored.currency,
    pricingRevision: stored.revision,
    terms,
    ...(proposed && {
      proposed: {
        paymentsEnabled: proposed.paymentsEnabled ?? saved?.payments_enabled === true,
        acceptedMethods: proposed.acceptedMethods,
      },
    }),
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
  return {
    rates,
    payable: rates.filter((rate) => rate.payableWith.length > 0).length,
    settings: {
      paymentsEnabled: saved?.payments_enabled === true,
      acceptedMethods: Array.isArray(saved?.accepted_methods) ? [...saved.accepted_methods] : [],
    },
    financeReason: finance.kind === "ready" ? null : finance.reason,
  };
}

/** The coverage on a transaction of its own that only reads and is always rolled back (its terms
 * and finance reads take share locks, which a READ ONLY transaction refuses), for Finance's
 * payment settings (VAY-2583). */
export function createRatePaymentCoverage(
  pool: Pick<pg.Pool, "connect">,
  switches: PricingPaymentSwitches,
): RatePaymentCoverageReader {
  return async (propertyId, proposed) => {
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

type SavedPaymentSettings = { paymentsEnabled: boolean; acceptedMethods: readonly string[] };
/** The change to judge, or how to make it from the settings as saved (a write that keeps some of
 * them, like setup's payment-methods save). */
export type ProposedPaymentChange =
  | ProposedPaymentSettings
  | ((saved: SavedPaymentSettings) => ProposedPaymentSettings);

/** VAY-2583: whether a payment-settings change must be refused because it would leave a live
 * booking page with no rate guests can pay for. Only a change that takes a way to pay away (a
 * method off, payments off) is refused, and only when the page had a payable rate before:
 * turning something on never is (a card not ready yet must stay switchable on to set it up), and a
 * page already without one can still save. Returns the coverage after the change when refused. */
export async function refusedPaymentChange<
  C extends { payable: number; settings: SavedPaymentSettings },
>(
  coverage: (propertyId: string, proposed?: ProposedPaymentSettings) => Promise<C | null>,
  propertyId: string,
  change: ProposedPaymentChange,
): Promise<C | null> {
  const before = await coverage(propertyId);
  if (!before || before.payable === 0) return null;
  const proposed = typeof change === "function" ? change(before.settings) : change;
  const takesAway =
    (before.settings.paymentsEnabled && proposed.paymentsEnabled === false) ||
    before.settings.acceptedMethods.some((method) => !proposed.acceptedMethods.includes(method));
  if (!takesAway) return null;
  const after = await coverage(propertyId, proposed);
  return after && after.payable === 0 ? after : null;
}

/** VAY-2583: the coverage after `proposed` when that change must be refused (refusedPaymentChange);
 * null when it may be saved, also when the coverage couldn't be read: a read failure never blocks a
 * payment save, it is only logged. */
export async function refusedRatePaymentChange<
  C extends { payable: number; settings: SavedPaymentSettings },
>(
  repository: {
    ratePaymentCoverage?: (
      propertyId: string,
      proposed?: ProposedPaymentSettings,
    ) => Promise<C | null>;
  },
  propertyId: string,
  change: ProposedPaymentChange,
  log: { error(obj: object, msg: string): void },
): Promise<C | null> {
  if (!repository.ratePaymentCoverage) return null;
  try {
    return await refusedPaymentChange(repository.ratePaymentCoverage, propertyId, change);
  } catch (error) {
    log.error({ err: error, propertyId }, "rate payment coverage read failed");
    return null;
  }
}
