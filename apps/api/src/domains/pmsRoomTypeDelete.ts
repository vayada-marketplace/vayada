import { createHash } from "node:crypto";
import type { PmsRoomTypeDeleteCleanup, PmsRoomTypeRetirementBlocker } from "@vayada/domain-pms";
import type { DistributionBookingPublicationTransaction as Client } from "./distributionBookingPublicationProjection.js";
import { suppressClosingRoomOffers } from "./distributionRoomClosure.js";
import { appendRoomClosureCalendar, closeRoomClosureInventory } from "./pmsRoomClosureCalendar.js";
import { recordPmsRoomClosureEvents } from "./pmsRoomClosureEvents.js";
import {
  readPmsRoomClosureState,
  type PmsRoomClosureScope,
  type PmsRoomClosureState,
} from "./pmsRoomClosureState.js";
import { retireClosingRoomUnits } from "./pmsRoomClosureUnits.js";

/**
 * One Delete for a room type (VAY-2132): what it would clean up and what still stops it. A room the
 * operating calendar holds is closed ("closure"); one it doesn't hold yet (added after the calendar was
 * saved, or before there is one) has no nights, so only its units are retired ("retire_units").
 */
export type PmsRoomTypeDeletePlan = {
  mode: "closure" | "retire_units";
  cutoffDate: string;
  closure: PmsRoomClosureState;
  blockers: PmsRoomTypeRetirementBlocker[];
  cleanup: PmsRoomTypeDeleteCleanup;
};

type CountsRow = {
  bound: boolean;
  futureNights: number;
  reservations: number;
  mappings: number;
  roomBlocks: number;
  protectedNights: number;
  unavailableUnits: number;
};

/** Reads the plan; under the delete's locks when it runs inside the command. */
export async function readPmsRoomTypeDeletePlan(
  client: Client,
  scope: { propertyId: string; roomTypeId: string },
  at: Date,
): Promise<PmsRoomTypeDeletePlan | null> {
  const closure = await readPmsRoomClosureState(client, scope, at);
  if (!closure) return null;
  const cutoffDate = closure.cutoffDate ?? at.toISOString().slice(0, 10);
  const counts = (
    await client.query<CountsRow>(
      `SELECT
        EXISTS(SELECT 1 FROM pms.operating_calendar_room_bindings binding
          WHERE binding.property_id=$1::uuid AND binding.room_type_id=$2::uuid
            AND binding.calendar_revision=(SELECT max(calendar_revision)
              FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid)) AS bound,
        (SELECT count(*)::int FROM pms.inventory_days day WHERE day.property_id=$1::uuid
          AND day.room_type_id=$2::uuid AND day.stay_date>=$3::date) AS "futureNights",
        ((SELECT count(*) FROM pms.operational_booking_assignments assignment
          WHERE assignment.property_id=$1::uuid AND assignment.room_type_id=$2::uuid
            AND assignment.assignment_status NOT IN ('checked_out','canceled','released'))
         + (SELECT count(*) FROM pms.active_inventory_reservation_receipts receipt
          JOIN pms.inventory_reservation_statuses status ON status.receipt_id=receipt.receipt_id
          WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=$2::uuid
            AND status.lifecycle_state IN ('reserved','handed_off') AND receipt.check_out>$3::date))::int AS reservations,
        ((SELECT count(*) FROM pms.channel_room_type_mappings mapping
          WHERE mapping.property_id=$1::uuid AND mapping.room_type_id=$2::uuid AND mapping.status<>'disabled')
         + (SELECT count(*) FROM pms.channel_rate_plan_mappings mapping
          WHERE mapping.property_id=$1::uuid AND mapping.room_type_id=$2::uuid AND mapping.status<>'disabled'))::int AS mappings,
        (SELECT count(*)::int FROM pms.room_blocks block WHERE block.property_id=$1::uuid
          AND (block.room_type_id=$2::uuid OR block.source_room_type_id=$2::uuid)
          AND block.status='active' AND block.ends_on>=$3::date) AS "roomBlocks",
        -- Host or channel limits on future nights (bookings and holds are counted above).
        (SELECT count(*)::int FROM pms.inventory_days day WHERE day.property_id=$1::uuid
          AND day.room_type_id=$2::uuid AND day.stay_date>=$3::date
          AND (day.manual_sellable_limit_count IS NOT NULL
            OR day.channel_sellable_limit_count IS NOT NULL OR day.closure_source_revision<>0)) AS "protectedNights",
        (SELECT count(*)::int FROM pms.rooms unit WHERE unit.property_id=$1::uuid
          AND unit.room_type_id=$2::uuid AND unit.status NOT IN ('available','retired')) AS "unavailableUnits"`,
      [scope.propertyId, scope.roomTypeId, cutoffDate],
    )
  ).rows[0]!;
  const mode = counts.bound ? "closure" : "retire_units";
  const linked = closure.blockers.includes("linked_inventory") ? 1 : 0;
  const blockers: PmsRoomTypeRetirementBlocker[] = [];
  const add = (
    category: PmsRoomTypeRetirementBlocker["category"],
    code: PmsRoomTypeRetirementBlocker["code"],
    affectedCount: number,
    action: string,
  ) => {
    if (affectedCount > 0) blockers.push({ category, code, affectedCount, action });
  };
  add(
    "reservations",
    "active_reservations",
    counts.reservations,
    "Cancel, check out or move this room type's bookings and holds first.",
  );
  add(
    "publication",
    "channel_mapping",
    counts.mappings,
    "Disconnect this room type in the Channel Manager first.",
  );
  add(
    "inventory",
    "last_room_type",
    mode === "closure" && closure.blockers.includes("last_operating_room") ? 1 : 0,
    "Add another room type before deleting this one.",
  );
  // Every closure blocker the host can't fix on this room type (a stale calendar, missing coverage,
  // protected nights that no block, link or override explains) means the calendar needs updating.
  const explained = new Set([
    "last_operating_room",
    ...(counts.reservations ? ["active_reservations", "protected_inventory"] : []),
    ...(counts.unavailableUnits ? ["protected_units"] : []),
    ...(counts.protectedNights ? ["protected_inventory"] : []),
    ...(counts.roomBlocks ? ["active_blocks", "protected_inventory"] : []),
    ...(linked ? ["linked_inventory", "protected_inventory"] : []),
  ]);
  // A room outside the calendar is fine to retire as long as it has no nights of its own.
  const calendarStale =
    mode === "closure"
      ? closure.blockers.some((code) => !explained.has(code))
      : counts.futureNights > 0;
  add(
    "inventory",
    "calendar_not_current",
    calendarStale ? 1 : 0,
    "Update the property calendar in setup, then delete the room type.",
  );
  add(
    "inventory",
    "protected_inventory",
    counts.protectedNights,
    "Remove the availability limits on this room type's future nights first.",
  );
  add(
    "physical_units",
    "unavailable_units",
    counts.unavailableUnits,
    "Set this room type's rooms back to available first.",
  );
  add("inventory", "room_blocks", counts.roomBlocks, "Release this room type's room blocks first.");
  add(
    "inventory",
    "linked_inventory",
    linked,
    "Remove this room type from its linked rooms first.",
  );
  return {
    mode,
    cutoffDate,
    closure,
    blockers,
    cleanup: {
      physicalUnits: closure.physicalUnitIds.length,
      futureNights: mode === "closure" ? closure.futureInventoryDays : 0,
      roomBlocks: counts.roomBlocks,
      linkedGroups: linked,
    },
  };
}

/** Retires the units of a room the operating calendar doesn't hold; it has no nights to close. */
export async function retireUnboundRoomTypeUnits(
  client: Client,
  scope: { propertyId: string; roomTypeId: string },
  acceptedAt: string,
): Promise<PmsRoomTypeDeleteCleanup> {
  const retired = await client.query(
    `UPDATE pms.rooms SET status='retired', updated_at=GREATEST(updated_at,$3::timestamptz)
     WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status='available'
     RETURNING id`,
    [scope.propertyId, scope.roomTypeId, acceptedAt],
  );
  if (retired.rowCount)
    await client.query(
      `UPDATE pms.room_types SET room_units_revision=room_units_revision+1
       WHERE property_id=$1::uuid AND id=$2::uuid`,
      [scope.propertyId, scope.roomTypeId],
    );
  return { physicalUnits: retired.rowCount ?? 0, futureNights: 0, roomBlocks: 0, linkedGroups: 0 };
}

/**
 * Closes the room as the VAY-910 closure does, inside the Delete's transaction: receipt, events, future
 * nights, units, a calendar revision without the room, hidden offers. The caller holds the closure lock
 * order (inventory, room facts, units, publication) and has checked the plan has no blockers.
 */
export async function closeRoomTypeForDelete(
  client: Client,
  scope: PmsRoomClosureScope,
  closure: PmsRoomClosureState,
  command: {
    keyHash: string;
    requestFingerprintHash: string;
    requestId: string;
    correlationId?: string;
  },
  at: Date,
): Promise<PmsRoomTypeDeleteCleanup> {
  if (closure.blockers.length || !closure.cutoffDate || !closure.coverageThrough)
    throw new Error("Room type delete closure requires a clear closure state");
  // The calendar revision references this key, so it lives as long as a closure's (1 year).
  const key = (
    await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
      (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        correlation_id,expires_at)
      VALUES ('pms','room_type.delete_close',$1,$2,'in_progress','property',$3::uuid,$4,
        $5::timestamptz+interval '1 year')
      ON CONFLICT DO NOTHING RETURNING id::text`,
      [
        command.keyHash,
        command.requestFingerprintHash,
        scope.propertyId,
        command.correlationId ?? command.requestId,
        at.toISOString(),
      ],
    )
  ).rows[0];
  if (!key) throw new Error("Room type delete closure key is already used");
  await client.query(
    `INSERT INTO pms.room_type_closures
    (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,expected_room_units_revision,
      previous_calendar_revision,closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::bigint,$7::bigint+1,$8::date,$9::timestamptz,$10::uuid)`,
    [
      scope.propertyId,
      scope.roomTypeId,
      key.id,
      command.requestFingerprintHash,
      closure.roomFactsRevision,
      closure.roomUnitsRevision,
      closure.calendarRevision,
      closure.cutoffDate,
      at.toISOString(),
      scope.actorUserId,
    ],
  );
  const events = await recordPmsRoomClosureEvents(
    client,
    scope,
    { idempotencyId: key.id, ...command },
    {
      calendarRevision: closure.calendarRevision! + 1,
      cutoffDate: closure.cutoffDate,
      coverageThroughExclusive: new Date(
        Date.parse(`${closure.coverageThrough}T00:00:00.000Z`) + 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      phase: "publication_refresh_required",
    },
    at,
  );
  const receipt = { propertyId: scope.propertyId, roomTypeId: scope.roomTypeId, commandId: key.id };
  const futureNights = await closeRoomClosureInventory(client, receipt);
  if (futureNights !== closure.futureInventoryDays)
    throw new Error("Room type delete inventory changed under coordination");
  const units = await retireClosingRoomUnits(client, receipt);
  await appendRoomClosureCalendar(client, receipt, events);
  await suppressClosingRoomOffers(client, receipt);
  const cleanup = {
    physicalUnits: units.retiredUnitIds.length,
    futureNights,
    roomBlocks: 0,
    linkedGroups: 0,
  };
  const metadata = JSON.stringify({ cleanup });
  await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',completed_at=$2::timestamptz,
      response_status_code=200,response_body_hash=$3,idempotency_metadata=$4::jsonb WHERE id=$1::uuid`,
    [key.id, at.toISOString(), createHash("sha256").update(metadata).digest("hex"), metadata],
  );
  return cleanup;
}
