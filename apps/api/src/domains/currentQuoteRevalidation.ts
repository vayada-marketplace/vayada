import type { PoolClient } from "pg";
import {
  evaluateSameDayBooking,
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
  storedPricingQuoteStatus,
} from "@vayada/domain-booking";
import { pricingObject } from "@vayada/domain-pms";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { lockCurrentPricingQuote } from "./currentPricingQuote.js";
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    pricingObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );

/** Current price/same-day gate only. Caller owns READ COMMITTED and retains locks.
 * Does not reserve inventory, consume promos, accept a quote or create a booking. */
export async function lockCurrentQuoteRevalidation(
  client: PoolClient,
  slug: unknown,
  quoteId: unknown,
) {
  if (
    typeof quoteId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quoteId)
  )
    return null;
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return null;
  const row = (
    await client.query(
      "SELECT id,payload FROM booking.pricing_quotes WHERE id=$1 AND property_id=$2 AND organization_id=$3",
      [quoteId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const stored = row
    ? decodeCurrentPricingQuoteRecord(row.payload, scope.propertyId, row.id)
    : null;
  if (!stored) return null;
  const quote = stored.quote,
    owner = await lockPublicPricingPublication(client, slug);
  if (!owner) return null;
  const bindings = publicPricingOfferBindings(owner);
  const selection = {
    version: quote.stay.addons.some((a) => a.version === "addon-selection.v2")
      ? "public-pricing-selection.v2"
      : "public-pricing-selection.v1",
    checkIn: quote.stay.checkIn,
    checkOut: quote.stay.checkOut,
    currency: quote.stay.currency,
    addons: quote.stay.addons,
    promoCode: quote.stay.promoCode,
    rooms: quote.stay.rooms.map((room) => ({
      selectionId: room.selectionId,
      guests: room.guests,
      publicOfferKey: bindings.find(
        (b) => b.roomTypeId === room.roomTypeId && b.offerId === room.offerId,
      )?.publicOfferKey,
    })),
  };
  const current = await lockCurrentPricingQuote(client, slug, selection, quote.paymentMethod, 900);
  if (!current) return null;
  // Full price comparison detects changed amounts under accidentally unchanged sources.
  // Acceptance mode is frozen at issuance (VAY-1274), so today's mode is not a
  // price revision. Return the original quote and never replace its accepted policy.
  const content = (q: typeof quote) => ({
    evaluator: q.evaluatorVersion,
    method: q.paymentMethod,
    stay: q.stay,
    rooms: q.rooms,
    evidence: { ...q.evidence, issuedAt: null, expiresAt: null },
  });
  if (canonical(content(quote)) !== canonical(content(current.quote))) return null;
  const policy = (
    await client.query(
      `SELECT enabled,cutoff_local_time AS "cutoffLocalTime",revision
    FROM booking.same_day_booking_policies WHERE property_id=$1 FOR SHARE`,
      [scope.propertyId],
    )
  ).rows[0];
  const location = (
    await client.query(
      "SELECT timezone FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE",
      [scope.propertyId],
    )
  ).rows[0];
  if (!location?.timezone || (policy && typeof policy.enabled !== "boolean")) return null;
  if (!(await lockPublicPricingAuthority(client, slug))) return null;
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  if (
    storedPricingQuoteStatus(
      quote,
      current.quote.stay,
      current.quote.evidence.revisions,
      {
        evaluatorVersion: current.quote.evaluatorVersion,
        paymentMethod: current.quote.paymentMethod,
      },
      now,
    ) !== "current"
  )
    return null;
  let sameDay;
  try {
    sameDay = evaluateSameDayBooking({
      checkIn: quote.stay.checkIn,
      policy: policy ?? SAME_DAY_BOOKING_POLICY_DEFAULTS,
      propertyTimeZone: location.timezone,
      now,
    });
  } catch {
    return null;
  }
  if (!sameDay.eligible || quote.stay.checkIn < sameDay.currentLocalDate) return null;
  return {
    kind: "current_quote_price" as const,
    quote,
    calculation: current.calculation,
    scope,
    checkedAt: now.toISOString(),
    sameDay: {
      ...sameDay,
      policyRevision: policy?.revision ?? 0,
      propertyTimeZone: location.timezone,
    },
  };
}
