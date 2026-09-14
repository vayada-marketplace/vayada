import type { PoolClient } from "pg";
import { evaluateSameDayBooking, SAME_DAY_BOOKING_POLICY_DEFAULTS } from "@vayada/domain-booking";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";

type CurrentQuote = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;

/** Final time gate, not acceptance. Caller retains READ COMMITTED and all owner
 * locks from pre-mutation revalidation, stages every potentially blocking write
 * first, and rolls back everything on failure. Only already-locked receipt writes
 * and commit may follow. Never reprice after consuming this quote's own promo use. */
export async function finishCurrentQuoteAcceptanceTime(
  client: PoolClient,
  slug: unknown,
  current: CurrentQuote,
): Promise<string> {
  const fail = (): never => {
    throw new Error("Quote acceptance time is unavailable");
  };
  const policy = (
    await client.query(
      `SELECT enabled,cutoff_local_time AS "cutoffLocalTime",revision
       FROM booking.same_day_booking_policies WHERE property_id=$1 FOR SHARE`,
      [current.scope.propertyId],
    )
  ).rows[0];
  const location = (
    await client.query(
      "SELECT timezone FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE",
      [current.scope.propertyId],
    )
  ).rows[0];
  if (
    !location?.timezone ||
    location.timezone !== current.sameDay.propertyTimeZone ||
    (policy?.revision ?? 0) !== current.sameDay.policyRevision ||
    (policy && typeof policy.enabled !== "boolean")
  )
    return fail();
  const scope = await lockPublicPricingAuthority(client, slug);
  if (
    !scope ||
    scope.propertyId !== current.scope.propertyId ||
    scope.organizationId !== current.scope.organizationId ||
    scope.authorityRevision !== current.scope.authorityRevision
  )
    return fail();
  // clock_timestamp, not transaction-start now(): lock waits consume quote lifetime.
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const issued = Date.parse(current.quote.evidence.issuedAt);
  const expires = Date.parse(current.quote.evidence.expiresAt);
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.valueOf()) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    now.valueOf() < issued ||
    now.valueOf() >= expires
  )
    return fail();
  try {
    const decision = evaluateSameDayBooking({
      checkIn: current.quote.stay.checkIn,
      policy: policy ?? SAME_DAY_BOOKING_POLICY_DEFAULTS,
      propertyTimeZone: location.timezone,
      now,
    });
    if (
      !decision.eligible ||
      decision.currentLocalDate !== current.sameDay.currentLocalDate ||
      current.quote.stay.checkIn < decision.currentLocalDate
    )
      return fail();
  } catch {
    return fail();
  }
  return now.toISOString();
}
