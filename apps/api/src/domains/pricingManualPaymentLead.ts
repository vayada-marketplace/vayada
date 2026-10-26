import type { ManualPricingPaymentMethod } from "@vayada/domain-booking";
import type { PoolClient } from "pg";
import type { PricingManualPaymentTerms } from "./pricingManualPayment.js";

/** Where and when a stay's check-in happens, for the bank-transfer and PayPal lead time. */
export type PricingCheckInPlace = Readonly<{
  /** IANA time zone of the property, such as "Asia/Colombo". */
  timeZone: string;
  /** The hotel's check-in time ("HH:MM"), or null: then the arrival day starts at 00:00. */
  checkInTime: string | null;
}>;

/** The instant `date` (YYYY-MM-DD) at `time` (HH:MM) in `timeZone`, or null if either is invalid. */
export function propertyLocalInstant(date: string, time: string, timeZone: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!day || !clock) return null;
  const wall = Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!, +clock[1]!, +clock[2]!);
  if (new Date(wall).toISOString().slice(0, 10) !== date) return null;
  let offset: number;
  try {
    offset = offsetMinutes(new Date(wall), timeZone);
    // Once more at the found instant, so a DST change between the two is respected.
    offset = offsetMinutes(new Date(wall - offset * 60_000), timeZone);
  } catch {
    return null;
  }
  return new Date(wall - offset * 60_000);
}

/** The property-local calendar date of `instant`. */
export function propertyLocalDate(instant: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(instant);
  } catch {
    return null;
  }
}

/**
 * Whether check-in (the arrival day at the hotel's check-in time, in the property's time zone) is
 * at least `hours` after `now`, or further away than that when `strict`. Unknown places or dates
 * answer false.
 */
export function checkInLeadAllows(input: {
  hours: number;
  strict?: boolean;
  checkIn: string;
  place: PricingCheckInPlace;
  now: Date;
}): boolean {
  const start = propertyLocalInstant(
    input.checkIn,
    input.place.checkInTime ?? "00:00",
    input.place.timeZone,
  );
  if (!start || !Number.isFinite(input.hours)) return false;
  const lead = start.getTime() - input.now.getTime();
  const window = input.hours * 3_600_000;
  return input.strict ? lead > window : lead >= window;
}

/** The first property-local arrival date `allows` accepts, or null if unknown. */
export function checkInLeadEarliestArrival(
  place: PricingCheckInPlace,
  now: Date,
  allows: (checkIn: string) => boolean,
): string | null {
  const today = propertyLocalDate(now, place.timeZone);
  if (!today) return null;
  // The longest window is 168 h, so the answer is at most nine days out.
  for (let days = 0; days <= 10; days += 1) {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    const checkIn = date.toISOString().slice(0, 10);
    if (allows(checkIn)) return checkIn;
  }
  return null;
}

/**
 * VAY-2145: bank transfer only when check-in is at least its payment window (48 h) away, PayPal
 * only when check-in is further away than the hotel's PayPal window. A booking's payment deadline
 * then always falls before the guest arrives. Unknown places or dates answer false.
 */
export function manualPaymentLeadTimeAllows(input: {
  method: ManualPricingPaymentMethod;
  paymentWindowHours: number;
  checkIn: string;
  place: PricingCheckInPlace;
  now: Date;
}): boolean {
  return checkInLeadAllows({
    hours: input.paymentWindowHours,
    strict: input.method !== "bank_transfer",
    checkIn: input.checkIn,
    place: input.place,
    now: input.now,
  });
}

/** The first property-local arrival date the method may be offered for, or null if unknown. */
export function manualPaymentEarliestArrival(input: {
  method: ManualPricingPaymentMethod;
  paymentWindowHours: number;
  place: PricingCheckInPlace;
  now: Date;
}): string | null {
  return checkInLeadEarliestArrival(input.place, input.now, (checkIn) =>
    manualPaymentLeadTimeAllows({ ...input, checkIn }),
  );
}

/** The property's check-in place and the database clock, or null without a time zone. The check-in
 * time is the one guests see and accept on /book: the current guest rules (guest choices), then
 * the older policy summary, then none (00:00). */
export async function readPricingCheckInPlace(
  client: Pick<PoolClient, "query">,
  propertyId: string,
): Promise<{ place: PricingCheckInPlace; now: Date } | null> {
  const row = (
    await client.query(
      `SELECT location.timezone AS "timeZone",
         COALESCE(
           (SELECT revision.choices->>'checkInTime' FROM booking.guest_choice_heads head
            JOIN booking.guest_choice_revisions revision
              ON revision.property_id = head.property_id AND revision.revision = head.revision
            WHERE head.property_id = property.id),
           to_char(summary.check_in_time, 'HH24:MI')
         ) AS "checkInTime",
         clock_timestamp() AS now
       FROM hotel_catalog.properties property
       LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
       LEFT JOIN hotel_catalog.property_policy_summaries summary
         ON summary.property_id = property.id
       WHERE property.id = $1`,
      [propertyId],
    )
  ).rows[0];
  if (typeof row?.timeZone !== "string" || !row.timeZone) return null;
  return {
    place: {
      timeZone: row.timeZone,
      checkInTime: typeof row.checkInTime === "string" ? row.checkInTime : null,
    },
    now: new Date(row.now),
  };
}

/** The lead time against the property's time zone, its check-in time and the database clock. */
export async function pricingManualLeadTimeAllows(
  client: Pick<PoolClient, "query">,
  propertyId: string,
  terms: Pick<PricingManualPaymentTerms, "method" | "paymentWindowHours">,
  checkIn: string,
): Promise<boolean> {
  const read = await readPricingCheckInPlace(client, propertyId);
  return (
    !!read &&
    manualPaymentLeadTimeAllows({
      method: terms.method,
      paymentWindowHours: terms.paymentWindowHours,
      checkIn,
      place: read.place,
      now: read.now,
    })
  );
}

/** Minutes the zone's wall clock is ahead of UTC at `instant`. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map(({ type, value }) => [type, value]),
  );
  const wall = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour!,
    +parts.minute!,
    +parts.second!,
  );
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}
