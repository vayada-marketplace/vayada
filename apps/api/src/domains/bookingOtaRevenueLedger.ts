import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";
import type { CurrentOtaRevenueNight } from "./bookingOtaRevenueCorrections.js";

/** Booking-owned read boundary. Caller keeps this transaction open through correction commit. */
export async function loadBookingOtaRevenueLedger(
  client: ExternalRevenueEvidenceClient,
  scope: {
    propertyId: string;
    bookingId: string;
    sourceBookingReference: string;
    currency: string;
  },
): Promise<CurrentOtaRevenueNight[]> {
  const fail = () => {
    throw new Error("alteration_revenue_ledger_unavailable");
  };
  const booking = (
    await client.query<{
      transactionId: string;
      checkIn: string;
      checkOut: string;
      roomCount: number;
    }>(
      `SELECT txid_current()::text AS "transactionId", check_in::text AS "checkIn",
       check_out::text AS "checkOut",room_count AS "roomCount"
     FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 AND source_system='pms'
       AND source_booking_id=$3 AND currency=$4 AND booking_channel='airbnb'
       AND lifecycle_status='confirmed' FOR UPDATE`,
      [scope.bookingId, scope.propertyId, scope.sourceBookingReference, scope.currency],
    )
  ).rows[0];
  if (!booking) return fail();
  const aggregate = await client.query<CurrentOtaRevenueNight & { supported: boolean }>(
    `SELECT (array_agg(id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "evidenceId",
       (array_agg(room_type_id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "roomTypeId",
       stay_date::text AS "stayDate",line_position AS "linePosition",
       max(recognized_on)::text AS "recognizedOn",sum(gross_room_amount)::text AS "grossRoomAmount",
       sum(occupied_room_nights)::int AS "occupiedRoomNights",
       (array_agg(evidence_quality ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "evidenceQuality",
       bool_and(source_kind='ota' AND currency=$3 AND economic_event IN
         ('room_night','occupancy_adjustment','correction')) AS supported
     FROM booking.nightly_revenue_evidence WHERE property_id=$1 AND guest_booking_id=$2
     GROUP BY stay_date,line_position ORDER BY stay_date,line_position LIMIT 1001`,
    [scope.propertyId, scope.bookingId, scope.currency],
  );
  const transaction = (await client.query<{ id: string }>("SELECT txid_current()::text AS id"))
    .rows[0];
  if (transaction?.id !== booking.transactionId || aggregate.rows.length > 1000) return fail();
  const nights = (Date.parse(booking.checkOut) - Date.parse(booking.checkIn)) / 86_400_000;
  if (
    !Number.isInteger(nights) ||
    nights < 1 ||
    booking.roomCount < 1 ||
    nights * booking.roomCount > 1000
  )
    return fail();
  let active = 0;
  const result: CurrentOtaRevenueNight[] = [];
  for (const { supported, ...line } of aggregate.rows) {
    if (
      !supported ||
      ![0, 1].includes(line.occupiedRoomNights) ||
      (line.grossRoomAmount === null) !== (line.evidenceQuality === "missing") ||
      (line.grossRoomAmount !== null && !/^\d{1,15}(?:\.\d{1,4})?$/.test(line.grossRoomAmount)) ||
      (line.occupiedRoomNights === 0 &&
        line.grossRoomAmount !== null &&
        Number(line.grossRoomAmount) !== 0)
    )
      return fail();
    if (line.occupiedRoomNights === 1) {
      if (
        line.stayDate < booking.checkIn ||
        line.stayDate >= booking.checkOut ||
        line.linePosition > booking.roomCount
      )
        return fail();
      active++;
    }
    result.push(line);
  }
  if (active !== nights * booking.roomCount) return fail();
  return result;
}
