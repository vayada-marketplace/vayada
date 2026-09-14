import type pg from "pg";
import { BOOKING_ROOM_SELECTION_VERSION, parseBookingRoomSelection } from "@vayada/domain-booking";

import type { NightlyRevenueBackfillCandidate } from "./bookingNightlyRevenueBackfill.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type BookingRow = {
  propertyId: string;
  guestBookingId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  currency: string;
  lifecycleStatus: string;
  sourceSystem: string;
  bookingChannel: string;
  bookingMetadata: unknown;
  quoteCurrency: string | null;
  quoteSnapshot: unknown;
  assignments: Assignment[];
};
type Assignment = NightlyRevenueBackfillCandidate["assignments"][number];
type ExactNight = NonNullable<
  NightlyRevenueBackfillCandidate["retainedEvidence"]["exactNightly"]
>[number];

export async function readUncapturedNightlyRevenueCandidates(
  client: QueryClient,
  options: { afterGuestBookingId?: string; limit?: number } = {},
): Promise<{
  transactionId: string | null;
  candidates: NightlyRevenueBackfillCandidate[];
  nextGuestBookingId: string | null;
}> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid page limit");
  const bookings = await client.query<BookingRow & { transactionId: string }>(
    `SELECT booking.property_id::text AS "propertyId",booking.id::text AS "guestBookingId",
       booking.check_in::text AS "checkIn",booking.check_out::text AS "checkOut",
       booking.room_count AS "roomCount",booking.currency::text,booking.lifecycle_status AS "lifecycleStatus",
       booking.source_system AS "sourceSystem",booking.booking_channel AS "bookingChannel",
       booking.booking_metadata AS "bookingMetadata",
       quote.currency::text AS "quoteCurrency",quote.selected_offer_snapshot AS "quoteSnapshot",
       assignment.rows AS assignments,txid_current()::text AS "transactionId"
     FROM booking.guest_bookings booking
     LEFT JOIN booking.quote_sessions quote ON quote.id=booking.quote_session_id
       AND quote.property_id=booking.property_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'position',stored.position,'roomTypeId',stored.room_type_id::text,
         'stayEvidenceKind',stored.stay_evidence_kind,
         'checkIn',stored.check_in::text,'checkOut',stored.check_out::text
       ) ORDER BY stored.position),'[]'::jsonb) AS rows
       FROM pms.operational_booking_assignments stored
       WHERE stored.guest_booking_id=booking.id
     ) assignment ON TRUE
     WHERE booking.lifecycle_status IN ('confirmed','completed')
       AND ($1::uuid IS NULL OR booking.id>$1::uuid)
       AND NOT EXISTS(SELECT 1 FROM booking.nightly_revenue_evidence evidence
         WHERE evidence.guest_booking_id=booking.id AND evidence.economic_event='room_night')
     ORDER BY booking.id LIMIT $2`,
    [options.afterGuestBookingId ?? null, limit],
  );
  return {
    transactionId: bookings.rows[0]?.transactionId ?? null,
    candidates: bookings.rows.map((booking) => candidate(booking)),
    nextGuestBookingId: bookings.rows.at(-1)?.guestBookingId ?? null,
  };
}

function candidate(row: BookingRow): NightlyRevenueBackfillCandidate {
  const sourceKind = source(row);
  const direct = sourceKind === "direct" ? directSnapshot(row) : null;
  const retainedEvidence: NightlyRevenueBackfillCandidate["retainedEvidence"] = {
    currency: direct ? (row.quoteCurrency ?? row.currency) : null,
    ...(direct ? { exactNightly: direct.exactNightly } : {}),
  };
  return {
    propertyId: row.propertyId,
    guestBookingId: row.guestBookingId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    roomCount: row.roomCount,
    currency: row.currency,
    lifecycleStatus: row.lifecycleStatus,
    sourceKind,
    assignments: direct?.assignments ?? row.assignments,
    retainedEvidence,
  };
}

function source(row: BookingRow): NightlyRevenueBackfillCandidate["sourceKind"] {
  const metadata = record(row.bookingMetadata);
  if (
    row.sourceSystem === "pms" &&
    row.bookingChannel === "direct" &&
    metadata["contractVersion"] === "pms-manual-booking.v1"
  )
    return "manual";
  if (["booking_com", "airbnb", "expedia", "agoda", "other_ota"].includes(row.bookingChannel))
    return "ota";
  return row.sourceSystem === "booking" ? "direct" : "migration";
}

function directSnapshot(
  row: BookingRow,
): { assignments: Assignment[]; exactNightly: ExactNight[] } | null {
  const metadataOffer = record(record(row.bookingMetadata)["selectedOffer"]);
  return parseDirectOffer(row, metadataOffer) ?? parseDirectOffer(row, record(row.quoteSnapshot));
}

function parseDirectOffer(
  row: BookingRow,
  offer: Record<string, unknown>,
): { assignments: Assignment[]; exactNightly: ExactNight[] } | null {
  const hasBundle = offer["roomSelection"] !== undefined || offer["roomLines"] !== undefined;
  if (!hasBundle) return parseSingleDirectOffer(row, offer);
  const selection = parseBookingRoomSelection(offer["roomSelection"]);
  const roomLines = offer["roomLines"];
  const savedSelection = parseBookingRoomSelection({
    contractVersion: BOOKING_ROOM_SELECTION_VERSION,
    lines: roomLines,
  });
  if (!selection || !savedSelection || JSON.stringify(selection) !== JSON.stringify(savedSelection))
    return null;
  const assignments: Assignment[] = [];
  const exactNightly: ExactNight[] = [];
  let position = 1;
  for (const [index, selected] of selection.lines.entries()) {
    const rawLine = (roomLines as unknown[])[index];
    const line = record(rawLine);
    const nights = nightly(record(line["offer"])["nightlyRoomAmounts"]);
    if (!nights) return null;
    for (let room = 0; room < selected.guests.length; room++, position++) {
      assignments.push({
        position,
        roomTypeId: selected.roomTypeId,
        stayEvidenceKind: "exact",
        checkIn: row.checkIn,
        checkOut: row.checkOut,
      });
      exactNightly.push(...nights.map((night) => ({ ...night, position })));
    }
  }
  return assignments.length === row.roomCount ? { assignments, exactNightly } : null;
}

function parseSingleDirectOffer(
  row: BookingRow,
  offer: Record<string, unknown>,
): { assignments: Assignment[]; exactNightly: ExactNight[] } | null {
  const roomTypeId = text(offer["roomTypeId"])?.toLowerCase();
  const nights = nightly(offer["nightlyRoomAmounts"]);
  if (!roomTypeId || !UUID.test(roomTypeId) || !nights || row.roomCount < 1) return null;
  return {
    assignments: Array.from({ length: row.roomCount }, (_, index) => ({
      position: index + 1,
      roomTypeId,
      stayEvidenceKind: "exact",
      checkIn: row.checkIn,
      checkOut: row.checkOut,
    })),
    exactNightly: Array.from({ length: row.roomCount }, (_, index) =>
      nights.map((night) => ({ ...night, position: index + 1 })),
    ).flat(),
  };
}

function nightly(value: unknown): Omit<ExactNight, "position">[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result = value.map((item) => {
    const row = record(item),
      stayDate = text(row["stayDate"]),
      amount = row["grossRoomAmount"],
      grossRoomAmount =
        typeof amount === "number" && Number.isFinite(amount) ? String(amount) : text(amount);
    return stayDate && grossRoomAmount ? { stayDate, grossRoomAmount } : null;
  });
  return result.every((item) => item !== null) ? result : null;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
