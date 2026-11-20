import { createHash } from "node:crypto";

import { pricingCurrencyScale } from "@vayada/domain-pms";
import type pg from "pg";

import { enqueuePartnerEvent, type PartnerEventType } from "./partnerWebhooks.js";

/**
 * VAY-2438: booking updates for connected partner apps (contract "What Vayada accepts and sends",
 * section 3). Every minute (Flamur, 2026-11-20) this compares each booking that used an app's code
 * with what the app was last sent, and when it changed queues the next version as an outbox event in
 * the same transaction as the new state. An update can arrive up to a minute late, and a booking
 * confirmed and cancelled within that minute is sent only as booking.cancelled.
 *
 * Which bookings: a booking.promo_applications row whose code is the app's (partner_client_id), at a
 * hotel the app is connected to; once sent, a booking stays followed, so a code taken off is reported
 * with promoCode null. Bookings that were never confirmed aren't reported. No guest data is read.
 *
 * Amounts (decided 2026-11-20): totalAmount is guest_bookings.total_amount, what the guest pays after
 * the discount; extrasAmount is the booking's current add-ons plus the required fees added on top of
 * the room price (the accepted quote's charge lines, latest amendment first), so the partner's
 * commission (totalAmount minus extrasAmount) is on the room price only.
 */
export type PartnerBookingSnapshot = {
  bookingId: string;
  reference: string;
  status: "confirmed" | "cancelled" | "no_show";
  promoCode: string | null;
  promoCodeId: string | null;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  currency: string;
  totalAmount: string;
  extrasAmount: string;
  discountAmount: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
};

type CandidateRow = {
  bookingId: string;
  appId: string;
  propertyId: string;
  reference: string;
  lifecycleStatus: string;
  noShow: boolean;
  promoCode: string | null;
  promoCodeId: string | null;
  discountAmount: string | null;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  currency: string;
  totalAmount: string;
  addonsAmount: string;
  feesMinor: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sentHash: string | null;
};

const CANDIDATES_SQL = `
WITH pairs AS (
  SELECT application.guest_booking_id AS booking_id, promo.partner_client_id AS app_id
  FROM booking.promo_applications application
  JOIN booking.promo_definitions promo ON promo.id = application.promo_definition_id
  WHERE application.guest_booking_id IS NOT NULL AND promo.partner_client_id IS NOT NULL
  UNION
  SELECT guest_booking_id, client_id FROM distribution.partner_booking_states
)
SELECT
  booking.id::text AS "bookingId", pairs.app_id::text AS "appId",
  booking.property_id::text AS "propertyId", booking.public_reference AS reference,
  booking.lifecycle_status AS "lifecycleStatus",
  (EXISTS (SELECT 1 FROM pms.operational_booking_assignments a
           WHERE a.guest_booking_id = booking.id AND a.property_id = booking.property_id
             AND a.assignment_payload->>'operationalStatus' = 'no_show')
   AND NOT EXISTS (SELECT 1 FROM pms.operational_booking_assignments a
           WHERE a.guest_booking_id = booking.id AND a.property_id = booking.property_id
             AND COALESCE(a.assignment_payload->>'operationalStatus', '') <> 'no_show'
             AND NOT a.assignment_payload @> '{"channexAlterationReleased": true}'::jsonb)
  ) AS "noShow",
  applied.code AS "promoCode", applied.id AS "promoCodeId",
  applied.discount_amount AS "discountAmount",
  to_char(booking.check_in, 'YYYY-MM-DD') AS "checkIn",
  to_char(booking.check_out, 'YYYY-MM-DD') AS "checkOut",
  booking.room_count AS "roomCount", booking.currency::text AS currency,
  booking.total_amount::text AS "totalAmount",
  COALESCE((SELECT sum(selection.total_amount) FROM booking.active_booking_addon_selections selection
            WHERE selection.guest_booking_id = booking.id), 0)::text AS "addonsAmount",
  (SELECT sum((line->>'amountMinor')::numeric)::text
   FROM booking.pricing_quote_acceptances acceptance
   LEFT JOIN LATERAL (
     SELECT amendment.quote_snapshot FROM booking.pricing_acceptance_amendments amendment
     WHERE amendment.acceptance_id = acceptance.id ORDER BY amendment.revision DESC LIMIT 1
   ) latest ON true
   CROSS JOIN LATERAL jsonb_array_elements(
     COALESCE(latest.quote_snapshot, acceptance.quote_snapshot)#>'{evidence,lines}'
   ) line
   WHERE acceptance.guest_booking_id = booking.id AND line->>'kind' = 'charge') AS "feesMinor",
  (SELECT min(event.occurred_at) FROM booking.booking_status_events event
   WHERE event.guest_booking_id = booking.id AND event.to_status = 'confirmed') AS "confirmedAt",
  (SELECT min(event.occurred_at) FROM booking.booking_status_events event
   WHERE event.guest_booking_id = booking.id AND event.to_status = 'canceled') AS "cancelledAt",
  booking.created_at AS "createdAt", booking.updated_at AS "updatedAt",
  sent.snapshot_hash AS "sentHash"
FROM pairs
JOIN booking.guest_bookings booking ON booking.id = pairs.booking_id
JOIN distribution.partner_connections connection
  ON connection.client_id = pairs.app_id AND connection.property_id = booking.property_id
 AND connection.status = 'active'
JOIN distribution.external_api_clients app
  ON app.id = pairs.app_id AND app.status = 'active' AND app.webhook_url IS NOT NULL
LEFT JOIN distribution.partner_booking_states sent
  ON sent.guest_booking_id = booking.id AND sent.client_id = pairs.app_id
LEFT JOIN LATERAL (
  SELECT promo.code, promo.id::text AS id, application.discount_amount::text AS discount_amount
  FROM booking.promo_applications application
  JOIN booking.promo_definitions promo ON promo.id = application.promo_definition_id
  WHERE application.guest_booking_id = booking.id AND application.application_status = 'applied'
    AND promo.partner_client_id = pairs.app_id
  LIMIT 1
) applied ON true`;

/** The booking as the app should see it now, or null when it isn't reported (never confirmed). */
export function partnerBookingSnapshot(row: CandidateRow): PartnerBookingSnapshot | null {
  const status =
    row.lifecycleStatus === "canceled"
      ? "cancelled"
      : row.lifecycleStatus === "no_show" || row.noShow
        ? "no_show"
        : row.lifecycleStatus === "confirmed" || row.lifecycleStatus === "completed"
          ? "confirmed"
          : null;
  // Older bookings without status events count as confirmed from their creation.
  const confirmedAt =
    row.confirmedAt ??
    (["confirmed", "completed", "no_show"].includes(row.lifecycleStatus) ? row.createdAt : null);
  if (!status || !confirmedAt) return null;
  const scale = pricingCurrencyScale(row.currency) ?? 2;
  const extras = units(row.addonsAmount) + minorUnits(row.feesMinor ?? "0", scale);
  return {
    bookingId: row.bookingId,
    reference: row.reference,
    status,
    promoCode: row.promoCode,
    promoCodeId: row.promoCodeId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    roomCount: row.roomCount,
    currency: row.currency,
    totalAmount: money(units(row.totalAmount), scale),
    extrasAmount: money(extras, scale),
    discountAmount: money(units(row.promoCode ? (row.discountAmount ?? "0") : "0"), scale),
    confirmedAt: confirmedAt.toISOString(),
    cancelledAt: status === "cancelled" ? (row.cancelledAt ?? row.updatedAt).toISOString() : null,
  };
}

export function partnerEventType(
  previous: PartnerBookingSnapshot["status"] | null,
  next: PartnerBookingSnapshot["status"],
): PartnerEventType {
  if (previous === next) return "booking.changed";
  if (next === "cancelled") return "booking.cancelled";
  if (next === "no_show") return "booking.no_show";
  return "booking.confirmed";
}

export const snapshotHash = (snapshot: PartnerBookingSnapshot) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

/** Queues the next version of every reported booking that changed since it was last sent. */
export async function runPartnerBookingSweep(options: {
  pool: pg.Pool;
  now?: () => Date;
  maxWrites?: number;
}): Promise<{ queued: number }> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const rows = (await pool.query<CandidateRow>(CANDIDATES_SQL)).rows;
  let queued = 0;
  for (const row of rows) {
    if (queued >= (options.maxWrites ?? 200)) break;
    const snapshot = partnerBookingSnapshot(row);
    if (!snapshot) continue;
    const hash = snapshotHash(snapshot);
    if (hash === row.sentHash) continue;
    if (await queueVersion(pool, row, snapshot, hash, now().toISOString())) queued += 1;
  }
  return { queued };
}

async function queueVersion(
  pool: pg.Pool,
  row: CandidateRow,
  snapshot: PartnerBookingSnapshot,
  hash: string,
  at: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The connection must still be active: a disconnect holds this row while it revokes, and its
    // connection.revoked is the last event the app gets.
    const connection = await client.query(
      `SELECT 1 FROM distribution.partner_connections
       WHERE client_id = $1::uuid AND property_id = $2::uuid AND status = 'active'
       FOR SHARE`,
      [row.appId, row.propertyId],
    );
    const sent = await client.query<{
      status: PartnerBookingSnapshot["status"];
      version: number;
      hash: string;
    }>(
      `SELECT status, version, snapshot_hash AS hash FROM distribution.partner_booking_states
       WHERE guest_booking_id = $1::uuid AND client_id = $2::uuid
       FOR UPDATE`,
      [row.bookingId, row.appId],
    );
    const previous = sent.rows[0];
    if (connection.rows.length === 0 || previous?.hash === hash) {
      await client.query("ROLLBACK");
      return false;
    }
    const version = (previous?.version ?? 0) + 1;
    await client.query(
      `INSERT INTO distribution.partner_booking_states
         (guest_booking_id, client_id, property_id, version, status, snapshot_hash, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $7)
       ON CONFLICT (guest_booking_id, client_id)
       DO UPDATE SET version = EXCLUDED.version, status = EXCLUDED.status,
                     snapshot_hash = EXCLUDED.snapshot_hash, updated_at = EXCLUDED.updated_at`,
      [row.bookingId, row.appId, row.propertyId, version, snapshot.status, hash, at],
    );
    const { bookingId, reference, ...rest } = snapshot;
    await enqueuePartnerEvent(client, {
      appId: row.appId,
      propertyId: row.propertyId,
      type: partnerEventType(previous?.status ?? null, snapshot.status),
      occurredAt: at,
      booking: { bookingId, reference, version, ...rest },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Decimal money as ten-thousandths, so sums stay exact. */
function units(decimal: string): bigint {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
}

function minorUnits(minor: string, scale: number): bigint {
  const [whole = "0"] = minor.split(".");
  return BigInt(whole) * 10n ** BigInt(4 - Math.min(scale, 4));
}

/** As the booking's own amounts: at least two decimals, more for currencies that have them. */
function money(value: bigint, scale: number): string {
  const decimals = Math.max(2, Math.min(scale, 4));
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, "0").slice(0, decimals);
  return `${whole}.${fraction}`;
}
