import {
  FIRST_RUN_DEFAULT_BED,
  firstRunRoomFacts,
  firstRunRoomLabels,
  type FirstRunBedChoice,
  type FirstRunRoomInput,
} from "@vayada/domain-booking";
import {
  parseCreateRoomTypeFactsCommand,
  parseDraftRoomId,
  parseReconcilePhysicalRoomUnitsCommand,
  parseSetPhysicalRoomOperationalLabelCommand,
  type PhysicalRoomOperationalLabelPort,
  type PhysicalRoomUnitReconcilePort,
  type RoomFactsCommandPort,
} from "@vayada/domain-pms";

import {
  firstRunDraftRoomId,
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
  type HotelFirstRunStepOutcome,
} from "./domains/hotelFirstRunSteps.js";

/**
 * Test support (VAY-2451): makes the setup's room type the way the first run's room step did before the
 * four-step setup took it over (the 7-step setup's request is gone): under the draft id `first-run-room-N`,
 * with its rooms named "Room N". The walk tests use it to stand in for the four-step setup's own room.
 */
export type FirstRunSetupRoomPorts = Pick<HotelFirstRunSetupPorts, "roomRead"> &
  Readonly<{
    roomFacts: Pick<RoomFactsCommandPort, "createRoomTypeFacts">;
    units: PhysicalRoomUnitReconcilePort;
    labels: PhysicalRoomOperationalLabelPort;
  }>;

function audit(actor: HotelFirstRunActor) {
  return {
    actor: { kind: "user" as const, userId: actor.userId },
    requestId: actor.requestId,
    correlationId: actor.correlationId,
    requestedAt: actor.requestedAt,
  };
}

const fail = (code: string, cause?: unknown) => Object.freeze({ ok: false as const, code, cause });
const ok = (wrote: boolean): HotelFirstRunStepOutcome => Object.freeze({ ok: true, wrote });

/**
 * Step 2: the room types in order, their rooms and the rooms' names. Skipped when the owner already has room
 * types of their own; resumes a half-done first run (a room type created, its rooms missing or not yet
 * named). Room names are unique in a hotel, so they count on across room types: Room 1–8, then Room 9–12.
 * Every room type gets the owner's bed choice (1.12b); a room type already made keeps its beds.
 */
export async function runFirstRunRooms(
  ports: FirstRunSetupRoomPorts,
  actor: HotelFirstRunActor,
  rooms: readonly FirstRunRoomInput[],
  bed: FirstRunBedChoice = FIRST_RUN_DEFAULT_BED,
): Promise<HotelFirstRunStepOutcome> {
  const ids = await Promise.all(
    rooms.map(async (_room, index) => {
      const draftRoomId = parseDraftRoomId(firstRunDraftRoomId(index))!;
      return (
        (await ports.roomRead.getDraftRoomTypeBinding(actor.propertyId, draftRoomId))?.roomTypeId ??
        null
      );
    }),
  );
  if (
    ids.every((id) => id === null) &&
    (await ports.roomRead.listRoomTypeFacts(actor.propertyId)).length > 0
  )
    return ok(false);
  let wrote = false;
  let nextNumber = 1;
  for (const [index, room] of rooms.entries()) {
    const outcome = await runFirstRunRoomType(
      ports,
      actor,
      index,
      room,
      ids[index] ?? null,
      nextNumber,
      bed,
    );
    if (!outcome.ok) return outcome;
    wrote ||= outcome.wrote;
    nextNumber = outcome.nextNumber;
  }
  return ok(wrote);
}

const ROOM_NUMBER = /^Room (\d+)$/;

async function runFirstRunRoomType(
  ports: FirstRunSetupRoomPorts,
  actor: HotelFirstRunActor,
  index: number,
  room: FirstRunRoomInput,
  existingRoomTypeId: string | null,
  nextNumber: number,
  bed: FirstRunBedChoice,
): Promise<Readonly<{ ok: true; wrote: boolean; nextNumber: number }> | ReturnType<typeof fail>> {
  const { propertyId } = actor;
  let wrote = false;
  let roomTypeId = existingRoomTypeId;
  if (!roomTypeId) {
    const facts = firstRunRoomFacts(room, bed);
    if (!facts) return fail("first_run_room_invalid");
    const command = parseCreateRoomTypeFactsCommand({
      organizationId: actor.organizationId,
      propertyId,
      // The first room type keeps the key it had when the first run made only one.
      idempotencyKey: firstRunIdempotencyKey(
        propertyId,
        "room_type",
        index === 0 ? facts : [index, facts],
      ),
      audit: audit(actor),
      draftRoomId: parseDraftRoomId(firstRunDraftRoomId(index))!,
      expectedRevision: 0,
      facts,
    });
    if (!command) return fail("first_run_room_invalid");
    const created = await ports.roomFacts.createRoomTypeFacts(command);
    if (!created.ok) return fail("first_run_room_failed", created.error);
    roomTypeId = created.response.roomType.roomTypeId;
    wrote = true;
  }

  const capacity = await ports.roomRead.getRoomTypeCapacity(propertyId, roomTypeId);
  if (!capacity) return fail("first_run_room_capacity_missing");
  let unitsRevision = capacity.roomUnitsRevision;
  if (capacity.activeUnitCount === 0) {
    const command = parseReconcilePhysicalRoomUnitsCommand({
      organizationId: actor.organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: unitsRevision,
      targetActiveUnitCount: room.numberOfRooms,
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_units", [
        roomTypeId,
        room.numberOfRooms,
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_room_units_invalid");
    const reconciled = await ports.units.reconcilePhysicalRoomUnits(command);
    if (!reconciled.ok) return fail("first_run_room_units_failed", reconciled.error);
    unitsRevision = reconciled.response.capacity.roomUnitsRevision;
    wrote = true;
  }

  // Name every unnamed room "Room N", after the numbers this and the earlier room types already use.
  const units = (
    await ports.roomRead.listPhysicalRoomUnitIdentities(propertyId, roomTypeId)
  ).filter((unit) => unit.lifecycle === "active");
  const unnamed = units.filter((unit) => unit.operationalLabelStatus !== "verified");
  const first = units.reduce((next, unit) => {
    const number =
      unit.operationalLabelStatus === "verified"
        ? Number(ROOM_NUMBER.exec(unit.operationalLabel)?.[1] ?? 0)
        : 0;
    return Math.max(next, number + 1);
  }, nextNumber);
  const labels = unnamed.length ? firstRunRoomLabels(unnamed.length, first) : [];
  for (const [unitIndex, unit] of unnamed.entries()) {
    const command = parseSetPhysicalRoomOperationalLabelCommand({
      organizationId: actor.organizationId,
      propertyId,
      roomTypeId,
      roomUnitId: unit.roomUnitId,
      expectedRevision: unitsRevision,
      operationalLabel: labels[unitIndex],
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_label", [
        unit.roomUnitId,
        labels[unitIndex],
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_room_label_invalid");
    const named = await ports.labels.setPhysicalRoomOperationalLabel(command);
    if (!named.ok) return fail("first_run_room_label_failed", named.error);
    unitsRevision = named.response.roomUnitsRevision;
    wrote = true;
  }
  return Object.freeze({ ok: true, wrote, nextNumber: first + unnamed.length });
}
