import type pg from "pg";

import type { NightlyRevenueBackfillLine } from "./bookingNightlyRevenueBackfill.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type StoredLine = {
  propertyId: string;
  guestBookingId: string;
  roomTypeId: string;
  stayDate: string;
  currency: string;
  linePosition: number;
  sourceKind: string;
  evidenceQuality: string;
  grossRoomAmount: string | null;
  occupiedRoomNights: number;
  storedRows: number;
  sourceRevisions: number[];
};

/** Independently proves the effective ledger state before the page transaction commits. */
export async function verifyAppliedNightlyRevenueBackfillPage(
  client: QueryClient,
  lines: readonly NightlyRevenueBackfillLine[],
) {
  const expected = [...lines].sort(compare);
  if (!expected.length) return result([]);
  const bookingIds = [...new Set(expected.map(({ guestBookingId }) => guestBookingId))].sort();
  const query = await client.query<StoredLine>(
    `SELECT property_id::text AS "propertyId",guest_booking_id::text AS "guestBookingId",
       stay_date::text AS "stayDate",currency::text,line_position AS "linePosition",
       SUM(gross_room_amount)::text AS "grossRoomAmount",
       SUM(occupied_room_nights)::int AS "occupiedRoomNights",COUNT(*)::int AS "storedRows",
       array_agg(DISTINCT source_revision::int ORDER BY source_revision::int) AS "sourceRevisions",
       (array_agg(room_type_id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "roomTypeId",
       (array_agg(source_kind ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "sourceKind",
       (array_agg(evidence_quality ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "evidenceQuality"
     FROM booking.nightly_revenue_evidence WHERE guest_booking_id=ANY($1::uuid[])
       AND economic_event<>'retained_charge'
     GROUP BY property_id,guest_booking_id,stay_date,currency,line_position
     ORDER BY guest_booking_id,stay_date,line_position`,
    [bookingIds],
  );
  const actual = [...query.rows].sort(compare);
  if (
    actual.length !== expected.length ||
    expected.some((line, index) => !matches(line, actual[index]))
  )
    throw new Error("Applied nightly revenue does not match the page plan");
  return result(actual);
}

function matches(expected: NightlyRevenueBackfillLine, actual: StoredLine | undefined) {
  return (
    actual !== undefined &&
    expected.propertyId === actual.propertyId &&
    expected.guestBookingId === actual.guestBookingId &&
    expected.roomTypeId === actual.roomTypeId &&
    expected.stayDate === actual.stayDate &&
    expected.currency === actual.currency &&
    expected.linePosition === actual.linePosition &&
    expected.sourceKind === actual.sourceKind &&
    expected.evidenceQuality === actual.evidenceQuality &&
    expected.grossRoomAmount === actual.grossRoomAmount &&
    actual.occupiedRoomNights === 1 &&
    actual.storedRows >= 1 &&
    actual.sourceRevisions.length >= 1
  );
}

function result(lines: StoredLine[]) {
  const groups = new Map<string, StoredLine[]>();
  for (const line of lines) {
    const id = `${line.propertyId}:${line.stayDate}:${line.currency}:${line.sourceKind}:${line.evidenceQuality}`;
    groups.set(id, [...(groups.get(id) ?? []), line]);
  }
  const reconciliation = [...groups.values()].map((group) => {
    const first = group[0]!;
    const revisions = new Set(
      group.flatMap(({ guestBookingId, sourceRevisions }) =>
        sourceRevisions.map((revision) => `${guestBookingId}:${revision}`),
      ),
    );
    return {
      propertyId: first.propertyId,
      stayDate: first.stayDate,
      currency: first.currency,
      sourceKind: first.sourceKind,
      evidenceQuality: first.evidenceQuality,
      bookingCount: new Set(group.map(({ guestBookingId }) => guestBookingId)).size,
      roomNightCount: group.length,
      revisionCount: revisions.size,
      storedRows: group.reduce((sum, line) => sum + line.storedRows, 0),
      occupiedRoomNights: group.reduce((sum, line) => sum + line.occupiedRoomNights, 0),
      grossRoomAmount: formatMoney(
        group.reduce((sum, line) => sum + money(line.grossRoomAmount), 0n),
      ),
      missingRoomNights: group.filter(({ grossRoomAmount }) => grossRoomAmount === null).length,
    };
  });
  return {
    lineCount: lines.length,
    storedRows: lines.reduce((sum, line) => sum + line.storedRows, 0),
    revisionCount: new Set(
      lines.flatMap(({ guestBookingId, sourceRevisions }) =>
        sourceRevisions.map((revision) => `${guestBookingId}:${revision}`),
      ),
    ).size,
    reconciliation,
  };
}

const compare = (
  a: Pick<NightlyRevenueBackfillLine, "guestBookingId" | "stayDate" | "linePosition">,
  b: Pick<NightlyRevenueBackfillLine, "guestBookingId" | "stayDate" | "linePosition">,
) =>
  `${a.guestBookingId}:${a.stayDate}:${a.linePosition}`.localeCompare(
    `${b.guestBookingId}:${b.stayDate}:${b.linePosition}`,
  );
const money = (value: string | null) => (value === null ? 0n : BigInt(value.replace(".", "")));
const formatMoney = (value: bigint) =>
  `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 10_000n}.${((value < 0n ? -value : value) % 10_000n).toString().padStart(4, "0")}`;
