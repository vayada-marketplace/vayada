import { createHash } from "node:crypto";
import type pg from "pg";

import type { NightlyRevenueBackfillLine } from "./bookingNightlyRevenueBackfill.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type Scope = Pick<
  NightlyRevenueBackfillLine,
  "guestBookingId" | "propertyId" | "currency" | "lifecycleState" | "sourceKind"
> & {
  roomCount: number;
};
type Current = {
  guestBookingId: string;
  roomTypeId: string;
  stayDate: string;
  linePosition: number;
  sourceKind: string;
  evidenceQuality: string;
  grossRoomAmount: string | null;
  occupiedRoomNights: number;
  tipId: string;
  tipRecognizedOn: string;
};
type WriteLine = Omit<NightlyRevenueBackfillLine, "evidenceFingerprint" | "lifecycleState"> & {
  recognizedOn: string;
  occupiedRoomNights: 0 | 1;
  economicEvent: "room_night" | "correction";
  lifecycleState: "confirmed" | "completed" | "corrected";
  sourceRevision: number;
  correctsEvidenceId: string | null;
  commandKey: string;
};

/** pageId is a stable cursor ID; caller owns one transaction from candidate read through commit. */
export async function applyNightlyRevenueBackfillPage(
  client: QueryClient,
  input: { pageId: string; recognizedOn: string; lines: readonly NightlyRevenueBackfillLine[] },
  readerTransactionId: string,
) {
  const lines = normalize(input);
  const ids = [...new Set(lines.map(({ guestBookingId }) => guestBookingId))].sort();
  const requestFingerprint = sha256(JSON.stringify({ recognizedOn: input.recognizedOn, lines }));
  const runPrefix = `backfill:v1:${sha256(input.pageId).slice(0, 32)}:`;
  const commandPrefix = `${runPrefix}${requestFingerprint}:`;
  const transaction = await client.query<{ id: string; isolation: string; readOnly: string }>(
    `SELECT txid_current()::text id,current_setting('transaction_isolation') isolation,
       current_setting('transaction_read_only') AS "readOnly"`,
  );
  const transactionScope = transaction.rows[0];
  if (
    transactionScope?.isolation !== "repeatable read" ||
    transactionScope.readOnly !== "off" ||
    transactionScope.id !== readerTransactionId
  )
    throw new Error("Backfill apply requires a writable REPEATABLE READ transaction");
  if (lines.length === 0) return result("unchanged", requestFingerprint, 0, []);

  const locked = await client.query<Scope>(
    `SELECT booking.id::text AS "guestBookingId",booking.property_id::text AS "propertyId",
       booking.currency::text,booking.lifecycle_status AS "lifecycleState",booking.room_count AS "roomCount",
       CASE WHEN booking.source_system='pms' AND booking.booking_channel='direct'
              AND booking.booking_metadata->>'contractVersion'='pms-manual-booking.v1' THEN 'manual'
            WHEN booking.booking_channel IN ('booking_com','airbnb','expedia','agoda','other_ota') THEN 'ota'
            WHEN booking.source_system='booking' THEN 'direct' ELSE 'migration' END AS "sourceKind"
     FROM booking.guest_bookings booking WHERE booking.id=ANY($1::uuid[])
     ORDER BY booking.id FOR UPDATE`,
    [ids],
  );
  validateScopes(lines, locked.rows);

  const priorRun = await client.query<{
    commandKey: string;
    guestBookingId: string;
    sourceRevision: number;
  }>(
    `SELECT command_key AS "commandKey",guest_booking_id::text AS "guestBookingId",
       source_revision::int AS "sourceRevision" FROM booking.nightly_revenue_evidence
     WHERE command_key LIKE $1||'%' ORDER BY command_key`,
    [runPrefix],
  );
  if (priorRun.rows.length) {
    if (priorRun.rows.some(({ commandKey }) => !commandKey.startsWith(commandPrefix)))
      throw new Error("Backfill run ID conflicts with different input");
    return result("replayed", requestFingerprint, ids.length, priorRun.rows);
  }

  const current = await client.query<Current>(
    `SELECT guest_booking_id::text AS "guestBookingId",stay_date::text AS "stayDate",
       line_position AS "linePosition",SUM(gross_room_amount)::text AS "grossRoomAmount",
       SUM(occupied_room_nights)::int AS "occupiedRoomNights",
       (array_agg(room_type_id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "roomTypeId",
       (array_agg(source_kind ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "sourceKind",
       (array_agg(evidence_quality ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "evidenceQuality",
       (array_agg(id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "tipId",
       (array_agg(recognized_on::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "tipRecognizedOn"
     FROM booking.nightly_revenue_evidence WHERE guest_booking_id=ANY($1::uuid[])
       AND economic_event<>'retained_charge' GROUP BY guest_booking_id,stay_date,line_position
     ORDER BY guest_booking_id,stay_date,line_position`,
    [ids],
  );
  const revisions = await client.query<{ guestBookingId: string; nextRevision: number }>(
    `SELECT booking.id::text AS "guestBookingId",COALESCE(MAX(evidence.source_revision),0)::int+1 AS "nextRevision"
     FROM booking.guest_bookings booking LEFT JOIN booking.nightly_revenue_evidence evidence
       ON evidence.guest_booking_id=booking.id WHERE booking.id=ANY($1::uuid[])
     GROUP BY booking.id ORDER BY booking.id`,
    [ids],
  );
  const writes = changes(lines, current.rows, revisions.rows, input.recognizedOn, commandPrefix);
  if (!writes.length) return result("unchanged", requestFingerprint, ids.length, []);
  await client.query(
    `INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id)
     SELECT DISTINCT line."propertyId"::uuid,line."roomTypeId"::uuid FROM jsonb_to_recordset($1::jsonb)
       AS line("propertyId" text,"roomTypeId" text) ON CONFLICT DO NOTHING`,
    [JSON.stringify(writes)],
  );
  const inserted = await client.query<{ guestBookingId: string; sourceRevision: number }>(
    `INSERT INTO booking.nightly_revenue_evidence(property_id,guest_booking_id,room_type_id,stay_date,
       recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,
       source_kind,evidence_quality,source_revision,line_position,corrects_evidence_id,command_key)
     SELECT line."propertyId"::uuid,line."guestBookingId"::uuid,line."roomTypeId"::uuid,
       line."stayDate"::date,line."recognizedOn"::date,line.currency,
       line."grossRoomAmount"::numeric,line."occupiedRoomNights",line."economicEvent",
       line."lifecycleState",line."sourceKind",line."evidenceQuality",line."sourceRevision",
       line."linePosition",line."correctsEvidenceId"::uuid,line."commandKey"
     FROM jsonb_to_recordset($1::jsonb) AS line("propertyId" text,"guestBookingId" text,
       "roomTypeId" text,"stayDate" text,"recognizedOn" text,currency text,"grossRoomAmount" text,
       "occupiedRoomNights" smallint,"economicEvent" text,"lifecycleState" text,"sourceKind" text,
       "evidenceQuality" text,"sourceRevision" bigint,"linePosition" int,"correctsEvidenceId" text,"commandKey" text)
     ORDER BY line."guestBookingId",line."stayDate",line."linePosition"
     RETURNING guest_booking_id::text AS "guestBookingId",source_revision::int AS "sourceRevision"`,
    [JSON.stringify(writes)],
  );
  return result("appended", requestFingerprint, ids.length, inserted.rows);
}

function normalize(input: {
  pageId: string;
  recognizedOn: string;
  lines: readonly NightlyRevenueBackfillLine[];
}) {
  if (!trimmed(input.pageId, 100) || !date(input.recognizedOn) || input.lines.length > 100_000)
    throw new Error("Backfill input is malformed");
  const lines = [...input.lines].sort(compare);
  const keys = new Set<string>();
  for (const line of lines) {
    const key = `${line.guestBookingId}:${line.stayDate}:${line.linePosition}`;
    if (
      !UUID.test(line.propertyId) ||
      !UUID.test(line.guestBookingId) ||
      !UUID.test(line.roomTypeId) ||
      !date(line.stayDate) ||
      !/^[A-Z]{3}$/.test(line.currency) ||
      !Number.isInteger(line.linePosition) ||
      line.linePosition < 1 ||
      line.linePosition > 1_000 ||
      !SHA.test(line.evidenceFingerprint) ||
      keys.has(key) ||
      !["confirmed", "completed"].includes(line.lifecycleState) ||
      !["direct", "ota", "manual", "migration"].includes(line.sourceKind) ||
      !["exact", "inferred", "missing"].includes(line.evidenceQuality) ||
      (line.grossRoomAmount === null) !== (line.evidenceQuality === "missing") ||
      (line.grossRoomAmount !== null && !MONEY.test(line.grossRoomAmount))
    )
      throw new Error("Backfill line is malformed");
    keys.add(key);
  }
  return lines;
}

function validateScopes(lines: NightlyRevenueBackfillLine[], rows: Scope[]) {
  const scopes = new Map(rows.map((row) => [row.guestBookingId, row]));
  if (scopes.size !== new Set(lines.map(({ guestBookingId }) => guestBookingId)).size)
    throw new Error("Backfill booking scope is unavailable");
  for (const group of groupByBooking(lines)) {
    const first = group[0]!,
      scope = scopes.get(first.guestBookingId),
      positions = [...new Set(group.map(({ linePosition }) => linePosition))];
    if (
      !scope ||
      group.some(
        (line) =>
          line.propertyId !== scope.propertyId ||
          line.currency !== scope.currency ||
          line.lifecycleState !== scope.lifecycleState ||
          line.sourceKind !== scope.sourceKind,
      ) ||
      positions.length !== scope.roomCount ||
      positions.some((position, index) => position !== index + 1)
    )
      throw new Error("Backfill booking scope changed");
  }
}

function changes(
  lines: NightlyRevenueBackfillLine[],
  current: Current[],
  revisions: Array<{ guestBookingId: string; nextRevision: number }>,
  recognizedOn: string,
  prefix: string,
): WriteLine[] {
  const desiredKeys = new Set(lines.map(key)),
    currentByBooking = new Map<string, Current[]>();
  for (const row of current)
    currentByBooking.set(row.guestBookingId, [
      ...(currentByBooking.get(row.guestBookingId) ?? []),
      row,
    ]);
  for (const [booking, rows] of currentByBooking)
    if (
      rows.length &&
      (rows.length !== lines.filter(({ guestBookingId }) => guestBookingId === booking).length ||
        rows.some((row) => !desiredKeys.has(key(row))))
    )
      throw new Error(`Backfill correction changes booking scope: ${booking}`);
  const currentByKey = new Map(current.map((row) => [key(row), row]));
  const next = new Map(revisions.map((row) => [row.guestBookingId, row.nextRevision]));
  return lines.flatMap((line) => {
    const stored = currentByKey.get(key(line)),
      sourceRevision = next.get(line.guestBookingId);
    if (!sourceRevision || sourceRevision > 2_147_483_647)
      throw new Error("Backfill source revision is unavailable");
    let write: Omit<WriteLine, "commandKey">;
    if (!stored)
      write = {
        ...line,
        recognizedOn: line.stayDate,
        occupiedRoomNights: 1,
        economicEvent: "room_night",
        sourceRevision,
        correctsEvidenceId: null,
      };
    else {
      if (
        stored.roomTypeId !== line.roomTypeId ||
        stored.sourceKind !== line.sourceKind ||
        stored.occupiedRoomNights !== 1
      )
        throw new Error("Backfill correction changes evidence scope");
      const desired = money(line.grossRoomAmount),
        existing = money(stored.grossRoomAmount);
      if (desired === null && existing === null && stored.evidenceQuality === line.evidenceQuality)
        return [];
      if (
        desired === null ||
        (desired === existing && stored.evidenceQuality !== line.evidenceQuality)
      )
        throw new Error("Backfill correction changes unsupported evidence quality");
      const delta = desired - (existing ?? 0n);
      if (delta === 0n && existing !== null && stored.evidenceQuality === line.evidenceQuality)
        return [];
      if (recognizedOn < stored.tipRecognizedOn || recognizedOn < line.stayDate)
        throw new Error("Backfill correction recognition date is too early");
      write = {
        ...line,
        grossRoomAmount: formatMoney(delta),
        recognizedOn,
        occupiedRoomNights: 0,
        economicEvent: "correction",
        lifecycleState: "corrected",
        sourceRevision,
        correctsEvidenceId: stored.tipId,
      };
    }
    return [{ ...write, commandKey: `${prefix}${sha256(JSON.stringify(write)).slice(0, 32)}` }];
  });
}

function result(
  outcome: "appended" | "replayed" | "unchanged",
  requestFingerprint: string,
  bookingCount: number,
  rows: Array<{ guestBookingId: string; sourceRevision: number }>,
) {
  return {
    outcome,
    requestFingerprint,
    bookingCount,
    insertedCount: outcome === "appended" ? rows.length : 0,
    sourceRevisions: Object.fromEntries(
      rows.map((row) => [row.guestBookingId, row.sourceRevision]),
    ),
  };
}
function groupByBooking(lines: NightlyRevenueBackfillLine[]) {
  const groups = new Map<string, NightlyRevenueBackfillLine[]>();
  for (const line of lines)
    groups.set(line.guestBookingId, [...(groups.get(line.guestBookingId) ?? []), line]);
  return [...groups.values()].map((group) =>
    group.sort((a, b) => a.linePosition - b.linePosition || a.stayDate.localeCompare(b.stayDate)),
  );
}
const compare = (a: NightlyRevenueBackfillLine, b: NightlyRevenueBackfillLine) =>
  `${a.guestBookingId}:${a.stayDate}:${a.linePosition}`.localeCompare(
    `${b.guestBookingId}:${b.stayDate}:${b.linePosition}`,
  );
const key = (line: { guestBookingId: string; stayDate: string; linePosition: number }) =>
  `${line.guestBookingId}:${line.stayDate}:${line.linePosition}`;
const money = (value: string | null) => (value === null ? null : BigInt(value.replace(".", "")));
const formatMoney = (value: bigint) =>
  `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 10_000n}.${((value < 0n ? -value : value) % 10_000n).toString().padStart(4, "0")}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const trimmed = (value: string, max: number) =>
  typeof value === "string" && value === value.trim() && !!value && value.length <= max;
const date = (value: string) =>
  DATE.test(value) &&
  !value.startsWith("0000-") &&
  new Date(value).toJSON() === `${value}T00:00:00.000Z`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/,
  DATE = /^\d{4}-\d{2}-\d{2}$/,
  MONEY = /^(?:0|[1-9]\d{0,14})\.\d{4}$/;
