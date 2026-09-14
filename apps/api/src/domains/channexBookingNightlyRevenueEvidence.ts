import type { PoolClient } from "pg";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

// prettier-ignore
export type ChannexRevenueRoom={checkIn:string;checkOut:string;days:Readonly<Record<string,string>>|null};
// prettier-ignore
type CurrentNight={id:string;roomTypeId:string;stayDate:string;recognizedOn:string;amount:string|null;occupied:number;linePosition:number;evidenceQuality:"exact"|"inferred"|"missing"};
// prettier-ignore
type Input={propertyId:string;bookingId:string;providerBookingId:string;revisionId:string;revisionAt:string;canceled:boolean;retainedCharges:readonly{roomIndex:number|null;amount:string}[];rooms:readonly ChannexRevenueRoom[]};
type CurrentCharge = Omit<CurrentNight, "occupied" | "evidenceQuality">;

export class ChannexRevenueEvidenceConflict extends Error {}

export async function appendChannexNightlyRevenueEvidence(client: PoolClient, input: Input) {
  const assignments = (
    await client.query<{ roomTypeId: string; position: number }>(
      `SELECT room_type_id::text AS "roomTypeId",position
       FROM pms.operational_booking_assignments
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid ORDER BY position`,
      [input.propertyId, input.bookingId],
    )
  ).rows;
  if (
    (!input.canceled && assignments.length !== input.rooms.length) ||
    assignments.some(({ position }, index) => position !== index + 1)
  )
    throw conflict();
  const revisionDate = (
    await client.query<{ date: string }>(
      `SELECT ($2::timestamptz AT TIME ZONE calendar.property_time_zone)::date::text date
       FROM pms.operating_calendar_revisions calendar JOIN pg_timezone_names zone
         ON zone.name=calendar.property_time_zone WHERE calendar.property_id=$1::uuid
       ORDER BY calendar.calendar_revision DESC LIMIT 1`,
      [input.propertyId, input.revisionAt],
    )
  ).rows[0]?.date;
  if (!revisionDate) throw conflict();
  await client.query(
    `INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id)
     SELECT $1::uuid,room_type_id::uuid FROM unnest($2::text[]) room_type_id
     ON CONFLICT DO NOTHING`,
    [input.propertyId, [...new Set(assignments.map(({ roomTypeId }) => roomTypeId))]],
  );
  const current = await loadCurrent(client, input),
    retained = await loadRetained(client, input);
  const desired = new Map<string, ExternalRevenueEvidenceLine>();
  if (!input.canceled)
    input.rooms.forEach((room, index) => {
      const assignment = assignments[index]!;
      for (const stayDate of stayDates(room.checkIn, room.checkOut)) {
        const grossRoomAmount = room.days?.[stayDate] ?? null;
        desired.set(key(stayDate, index + 1), {
          roomTypeId: assignment.roomTypeId,
          stayDate,
          recognizedOn: stayDate,
          grossRoomAmount,
          occupiedRoomNights: 1,
          economicEvent: "room_night",
          lifecycleState: "confirmed",
          evidenceQuality: grossRoomAmount === null ? "missing" : "exact",
          linePosition: index + 1,
        });
      }
    });
  const prior = new Map(current.map((night) => [key(night.stayDate, night.linePosition), night]));
  const lines: ExternalRevenueEvidenceLine[] = [];
  const secondPhase: ExternalRevenueEvidenceLine[] = [];
  for (const [nightKey, night] of desired) {
    const existing = prior.get(nightKey);
    if (!existing) {
      lines.push(
        current.length
          ? {
              ...night,
              recognizedOn: later(night.stayDate, revisionDate),
              economicEvent: "occupancy_adjustment",
              lifecycleState: "corrected",
            }
          : night,
      );
      continue;
    }
    prior.delete(nightKey);
    if (![0, 1].includes(existing.occupied)) throw conflict();
    if (existing.occupied === 0) {
      lines.push({
        ...night,
        recognizedOn: later(night.stayDate, existing.recognizedOn, revisionDate),
        economicEvent: "occupancy_adjustment",
        lifecycleState: "corrected",
        correctsEvidenceId: existing.id,
      });
      continue;
    }
    if (existing.roomTypeId !== night.roomTypeId) {
      lines.push(deactivate(existing, "corrected", revisionDate));
      secondPhase.push(night);
      continue;
    }
    if (night.grossRoomAmount === null) {
      if (existing.evidenceQuality === "missing") continue;
      lines.push(deactivate(existing, "corrected", revisionDate));
      secondPhase.push(night);
      continue;
    }
    const delta = units(night.grossRoomAmount) - units(existing.amount ?? "0");
    if (delta || existing.evidenceQuality === "missing")
      lines.push({
        ...night,
        recognizedOn: later(night.stayDate, existing.recognizedOn, revisionDate),
        grossRoomAmount: decimal(delta),
        occupiedRoomNights: 0,
        economicEvent: "correction",
        lifecycleState: "corrected",
        correctsEvidenceId: existing.id,
      });
  }
  for (const existing of prior.values()) {
    if (existing.occupied === 0) continue;
    if (existing.occupied !== 1) throw conflict();
    lines.push(deactivate(existing, input.canceled ? "canceled" : "corrected", revisionDate));
  }
  retainedLines(input, revisionDate, assignments, current, retained).forEach((line) =>
    lines.push(line),
  );
  await appendLines(client, input, "primary", lines);
  if (!secondPhase.length) return;
  const tips = new Map(
    (await loadCurrent(client, input)).map((night) => [
      key(night.stayDate, night.linePosition),
      night,
    ]),
  );
  await appendLines(
    client,
    input,
    "reactivate",
    secondPhase.map((night) => {
      const tip = tips.get(key(night.stayDate, night.linePosition));
      if (!tip || tip.occupied !== 0) throw conflict();
      return {
        ...night,
        recognizedOn: later(night.stayDate, tip.recognizedOn, revisionDate),
        economicEvent: "occupancy_adjustment",
        lifecycleState: "corrected",
        correctsEvidenceId: tip.id,
      };
    }),
  );
}

function deactivate(
  night: CurrentNight,
  lifecycleState: "canceled" | "corrected",
  revisionDate: string,
): ExternalRevenueEvidenceLine {
  return {
    roomTypeId: night.roomTypeId,
    stayDate: night.stayDate,
    recognizedOn: later(night.stayDate, night.recognizedOn, revisionDate),
    grossRoomAmount: night.amount === null ? null : decimal(-units(night.amount)),
    occupiedRoomNights: -1,
    economicEvent: "occupancy_adjustment",
    lifecycleState,
    evidenceQuality: night.amount === null ? "missing" : "exact",
    linePosition: night.linePosition,
    correctsEvidenceId: night.id,
  };
}

async function loadCurrent(client: PoolClient, input: Input): Promise<CurrentNight[]> {
  return (
    await client.query<CurrentNight>(
      `WITH RECURSIVE retained AS (
         SELECT id FROM booking.nightly_revenue_evidence
         WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND economic_event='retained_charge'
         UNION ALL
         SELECT evidence.id FROM booking.nightly_revenue_evidence evidence
         JOIN retained ON evidence.corrects_evidence_id=retained.id
         WHERE evidence.property_id=$1::uuid AND evidence.guest_booking_id=$2::uuid
           AND evidence.economic_event='correction'),
       state AS (SELECT id,room_type_id,stay_date,recognized_on,line_position,evidence_quality,
         source_revision,created_at,SUM(occupied_room_nights) OVER scope AS occupied,
         SUM(gross_room_amount) OVER scope AS amount,
         row_number() OVER (scope ORDER BY source_revision DESC,created_at DESC,id DESC) tip
       FROM booking.nightly_revenue_evidence
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid
         AND id NOT IN (SELECT id FROM retained)
       WINDOW scope AS (PARTITION BY stay_date,line_position))
       SELECT id::text,room_type_id::text AS "roomTypeId",stay_date::text AS "stayDate",
         recognized_on::text AS "recognizedOn",amount::text,occupied::int,line_position AS "linePosition",
         evidence_quality AS "evidenceQuality"
       FROM state WHERE tip=1 ORDER BY stay_date,line_position`,
      [input.propertyId, input.bookingId],
    )
  ).rows;
}

async function loadRetained(client: PoolClient, input: Input): Promise<CurrentCharge[]> {
  return (
    await client.query<CurrentCharge>(
      `WITH RECURSIVE chain AS (
         SELECT id,room_type_id,stay_date,recognized_on,line_position,gross_room_amount,source_revision,created_at,id root
         FROM booking.nightly_revenue_evidence
         WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND economic_event='retained_charge'
         UNION ALL
         SELECT evidence.id,evidence.room_type_id,evidence.stay_date,evidence.recognized_on,evidence.line_position,
           evidence.gross_room_amount,evidence.source_revision,evidence.created_at,chain.root
         FROM booking.nightly_revenue_evidence evidence JOIN chain ON evidence.corrects_evidence_id=chain.id
         WHERE evidence.property_id=$1::uuid AND evidence.guest_booking_id=$2::uuid
           AND evidence.economic_event='correction')
       SELECT (array_agg(id ORDER BY source_revision DESC,created_at DESC,id DESC))[1]::text id,
         (array_agg(room_type_id ORDER BY source_revision DESC,created_at DESC,id DESC))[1]::text AS "roomTypeId",
         (array_agg(stay_date ORDER BY source_revision DESC,created_at DESC,id DESC))[1]::text AS "stayDate",
         (array_agg(recognized_on ORDER BY source_revision DESC,created_at DESC,id DESC))[1]::text AS "recognizedOn",
         SUM(gross_room_amount)::text amount,line_position AS "linePosition"
       FROM chain GROUP BY root,line_position ORDER BY line_position`,
      [input.propertyId, input.bookingId],
    )
  ).rows;
}

function retainedLines(
  input: Input,
  revisionDate: string,
  assignments: readonly { roomTypeId: string; position: number }[],
  current: readonly CurrentNight[],
  retained: readonly CurrentCharge[],
): ExternalRevenueEvidenceLine[] {
  if (!input.canceled) return [];
  const amounts = new Map<number, bigint>();
  for (const charge of input.retainedCharges) {
    const chargeAmount = units(charge.amount);
    if (chargeAmount === 0n) continue;
    const position =
      charge.roomIndex === null ? (assignments.length === 1 ? 1 : 0) : charge.roomIndex + 1;
    if (!position || !assignments[position - 1]) throw conflict();
    amounts.set(position, (amounts.get(position) ?? 0n) + chargeAmount);
  }
  const prior = new Map<number, CurrentCharge>();
  for (const charge of retained) {
    if (prior.has(charge.linePosition)) throw conflict();
    prior.set(charge.linePosition, charge);
  }
  return [...new Set([...amounts.keys(), ...prior.keys()])]
    .sort((a, b) => a - b)
    .flatMap<ExternalRevenueEvidenceLine>((position) => {
      const amount = amounts.get(position) ?? 0n,
        existing = prior.get(position);
      if (existing) {
        const delta = amount - units(existing.amount ?? "0");
        return delta === 0n
          ? []
          : [
              {
                roomTypeId: existing.roomTypeId,
                stayDate: existing.stayDate,
                recognizedOn: later(existing.stayDate, existing.recognizedOn, revisionDate),
                grossRoomAmount: decimal(delta),
                occupiedRoomNights: 0,
                economicEvent: "correction",
                lifecycleState: "corrected",
                evidenceQuality: "exact",
                linePosition: position,
                correctsEvidenceId: existing.id,
              },
            ];
      }
      if (amount === 0n) return [];
      const anchor = current.find((night) => night.linePosition === position);
      if (!anchor) throw conflict();
      return [
        {
          roomTypeId: anchor.roomTypeId,
          stayDate: anchor.stayDate,
          recognizedOn: later(anchor.stayDate, revisionDate),
          grossRoomAmount: decimal(amount),
          occupiedRoomNights: 0,
          economicEvent: "retained_charge",
          lifecycleState: "canceled",
          evidenceQuality: "exact",
          linePosition: position,
        },
      ];
    });
}

// prettier-ignore
async function appendLines(client:PoolClient,input:Input,phase:string,lines:readonly ExternalRevenueEvidenceLine[]){for(let offset=0;offset<lines.length;offset+=1_000)await appendExternalNightlyRevenueEvidence(client,{propertyId:input.propertyId,guestBookingId:input.bookingId,sourceKind:"ota",sourceBookingReference:`channex:${input.propertyId}:${input.providerBookingId}`,idempotencyKey:`channex:${input.providerBookingId}:${input.revisionId}:nightly-revenue:${phase}:${offset/1_000}:v1`,lines:lines.slice(offset,offset+1_000)})}

// prettier-ignore
function stayDates(checkIn:string,checkOut:string):string[]{const dates:string[]=[],cursor=new Date(`${checkIn}T00:00:00Z`),end=new Date(`${checkOut}T00:00:00Z`);while(cursor<end){dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1)}return dates}
// prettier-ignore
const key=(date:string,position:number)=>`${date}:${position}`,later=(...dates:string[])=>dates.reduce((latest,date)=>date>latest?date:latest),conflict=()=>new ChannexRevenueEvidenceConflict("nightly_revenue_evidence_conflict");
// prettier-ignore
const units=(value:string)=>{const negative=value.startsWith("-"),[whole,fraction=""]=(negative?value.slice(1):value).split("."),result=BigInt(`${whole}${fraction.padEnd(4,"0")}`);return negative?-result:result};
// prettier-ignore
function decimal(value:bigint):string{const negative=value<0n,digits=(negative?-value:value).toString().padStart(5,"0"),result=`${digits.slice(0,-4)}.${digits.slice(-4)}`;return negative&&value!==0n?`-${result}`:result}
