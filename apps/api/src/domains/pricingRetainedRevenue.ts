import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pricingMinor } from "./pricingCardRefund.js";

/** Splits `total` over `weights` in proportion, largest remainder first: the shares always add up
 * to `total` exactly, and equal remainders go to the earlier weight. */
export function splitByWeight(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n || total <= 0n) return weights.map(() => 0n);
  const shares = weights.map((weight) => (total * weight) / sum);
  let left = total - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (left === 0n) break;
    shares[index]! += 1n;
    left -= 1n;
  }
  return shares;
}

/** An evidence amount (NUMERIC(19,4)) in ten-thousandths, exactly. */
const tenThousandths = (value: string): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw new Error("Nightly revenue amount is invalid.");
  const amount = BigInt(match[2]!) * 10000n + BigInt((match[3] ?? "").padEnd(4, "0"));
  return match[1] ? -amount : amount;
};
const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;

/** After a paid card stay's cancel cleared its nights (`captureDirectNightlyRevenueEvidence`
 * with `clear`, same fingerprint): what the hotel keeps becomes retained revenue on those nights
 * (VAY-2205, Flamur 2026-10-18, as PMS manual cancellations do). The kept share of what was paid
 * (`keptMinor` of `paidMinor`, or of the stay's total for a deposit) of the nights' room value is
 * split over the nights by their room prices; add-ons keep their own records. Each night's share
 * is recognised on its stay date, as the evidence rule requires. Idempotent per cancel; returns
 * the number of nights recorded. */
export async function recordPricingRetainedRevenue(
  client: Pick<PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    fingerprint: string;
    keptMinor: bigint;
    paidMinor: bigint;
  },
): Promise<number> {
  if (input.keptMinor <= 0n || input.paidMinor <= 0n) return 0;
  const key = createHash("sha256").update(input.fingerprint).digest("hex");
  // The nights this cancel cleared, by the clear's own command keys.
  const nights = (
    await client.query<{
      stayDate: string;
      linePosition: number;
      roomTypeId: string;
      amount: string;
      currency: string;
    }>(
      `SELECT stay_date::text AS "stayDate",line_position AS "linePosition",room_type_id::text AS "roomTypeId",
         (-SUM(gross_room_amount))::text AS amount,currency
       FROM booking.nightly_revenue_evidence
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND economic_event='occupancy_adjustment'
         AND occupied_room_nights=-1 AND command_key LIKE $3
       GROUP BY stay_date,line_position,room_type_id,currency
       ORDER BY stay_date,line_position,room_type_id`,
      [input.propertyId, input.guestBookingId, `direct:${key}:%`],
    )
  ).rows;
  const values = nights.map((night) => tenThousandths(night.amount));
  const roomTotal = values.reduce((a, b) => a + b, 0n);
  if (roomTotal <= 0n) return 0;
  const kept = input.keptMinor > input.paidMinor ? input.paidMinor : input.keptMinor;
  // A full payment is the stay's online part; a deposit is a share of the whole stay, so what it
  // keeps is that share of the stay's value (VAY-2205).
  const deposit = (
    await client.query<{ total: string; currency: string }>(
      `SELECT booking.total_amount::text AS total,trim(booking.currency) AS currency
       FROM booking.guest_bookings booking
       JOIN finance.payments payment
         ON payment.id=booking.active_card_payment_id AND payment.property_id=booking.property_id
       WHERE booking.property_id=$1::uuid AND booking.id=$2::uuid AND payment.payment_kind='deposit'`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const stayMinor = deposit ? pricingMinor(deposit.total, deposit.currency) : null;
  const basis = stayMinor && stayMinor > input.paidMinor ? stayMinor : input.paidMinor;
  // In cents, half-up: the nights keep the same share of their room value as the hotel keeps of
  // what the payment stood for.
  const retained = (roomTotal * kept * 2n + basis * 100n) / (basis * 200n);
  const shares = splitByWeight(retained, values);
  const lines = nights
    .map((night, index) => ({ ...night, share: shares[index]! }))
    .filter((line) => line.share > 0n);
  if (!lines.length) return 0;
  await client.query(
    `INSERT INTO booking.nightly_revenue_evidence
       (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,
        occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,
        line_position,corrects_evidence_id,command_key)
     SELECT $1::uuid,$2::uuid,(line->>'roomTypeId')::uuid,(line->>'stayDate')::date,(line->>'stayDate')::date,
       line->>'currency',(line->>'share')::numeric,0,'retained_charge','canceled','direct','exact',
       (SELECT COALESCE(MAX(source_revision),0)+1 FROM booking.nightly_revenue_evidence
        WHERE guest_booking_id=$2::uuid),
       (line->>'linePosition')::int,NULL,
       'direct-retained:'||$4||':'||(line->>'stayDate')||':'||(line->>'linePosition')||':'||(line->>'roomTypeId')
     FROM jsonb_array_elements($3::jsonb) line
     ON CONFLICT (property_id,command_key) DO NOTHING`,
    [
      input.propertyId,
      input.guestBookingId,
      JSON.stringify(lines.map((line) => ({ ...line, share: decimal(line.share) }))),
      key,
    ],
  );
  return lines.length;
}
