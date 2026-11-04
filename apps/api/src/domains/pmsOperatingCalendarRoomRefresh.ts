import { randomUUID } from "node:crypto";

import {
  PMS_OPERATING_CALENDAR_AUTHORIZATION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarProposalRequest,
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseUpsertPmsOperatingCalendarCommand,
  type PmsInventoryMaterializationPort,
  type PmsOperatingCalendarCommandPort,
  type PmsOperatingCalendarImpactPreviewPort,
  type PmsOperatingCalendarReadPort,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingCalendarRoomEvidencePorts,
  type PmsStartingSellableLimitInput,
  type RoomFactsCommandAudit,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

import { firstRunInventoryHorizon } from "./hotelFirstRunCalendar.js";

/**
 * VAY-2469: room changes made after the calendar was saved (Duplicate, Add room type, "Total rooms",
 * a room added, retired or renamed) leave the calendar behind. A room type the calendar doesn't
 * list has no nights, so the booking page shows it sold out and New Booking says "room
 * unavailable"; a changed room count keeps selling the old count. Only setup's calendar step
 * used to catch up.
 *
 * This step does what that save does, with the hotel's own settings: the same opening schedule,
 * minimum stay and room limits (a new room type sells all its rooms; a limit equal to the old room
 * count follows the new count, a lower one stays unless it is now too high), then prepares the
 * nights through the hotel's current calendar end (at most a year, like setup), so no new dates
 * open. A calendar saved in setup whose nights were never prepared gets its nights the same way.
 * It changes nothing when the calendar is current; when the hotel has no calendar or
 * prepared nights yet (setup isn't done) or its calendar has ended; when a night holds more
 * bookings, blocks or limits than the rooms left; or when the calendar is behind for another
 * reason (a new time zone, a room type without rooms), which still needs setup's calendar step.
 */

type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
};

export type PmsOperatingCalendarRoomRefreshPorts = Readonly<{
  pool: Queryable;
  calendarRead: Pick<PmsOperatingCalendarReadPort, "getCurrentOperatingCalendarConfiguration">;
  rooms: PmsOperatingCalendarRoomEvidencePorts;
  preview: PmsOperatingCalendarImpactPreviewPort;
  calendar: PmsOperatingCalendarCommandPort;
  materialization: PmsInventoryMaterializationPort;
  now?: () => Date;
}>;

/** Who the calendar is saved as: the staff member who changed the rooms, or (from the hourly job)
 * the last person who saved this hotel's calendar. Their access is checked again by the save. */
export type PmsOperatingCalendarRoomRefreshActor = Readonly<{
  organizationId: string;
  propertyId: string;
  userId: string;
  requestId: string;
  correlationId: string | null;
}>;

export type PmsOperatingCalendarRoomRefreshResult =
  | Readonly<{ outcome: "current" | "no_calendar" | "no_inventory" }>
  | Readonly<{ outcome: "not_room_change"; reason: string }>
  | Readonly<{ outcome: "refreshed"; calendarRevision: number; savedCalendar: boolean }>
  | Readonly<{ outcome: "failed"; step: "preview" | "save" | "inventory"; error: unknown }>;

/** The conflicts a room change causes. Anything else needs setup's calendar step. */
const ROOM_CONFLICTS: ReadonlySet<string> = new Set([
  "room_type_set_conflict",
  "room_units_revision_conflict",
]);

export async function refreshPmsOperatingCalendarRooms(
  ports: PmsOperatingCalendarRoomRefreshPorts,
  actor: PmsOperatingCalendarRoomRefreshActor,
): Promise<PmsOperatingCalendarRoomRefreshResult> {
  const { propertyId } = actor;
  const current = await ports.calendarRead.getCurrentOperatingCalendarConfiguration(propertyId);
  if (!current) return Object.freeze({ outcome: "no_calendar" });
  const coverage = await readCoverage(ports.pool, propertyId);
  if (!coverage) return Object.freeze({ outcome: "no_inventory" });
  const { configuration } = current;
  const requestedAt = (ports.now?.() ?? new Date()).toISOString();
  const audit: RoomFactsCommandAudit & { actor: { kind: "user"; userId: string } } = {
    actor: { kind: "user", userId: actor.userId },
    requestId: actor.requestId,
    correlationId: actor.correlationId,
    requestedAt,
  };
  let calendarRevision = configuration.calendarRevision;
  let savedCalendar = false;
  if (current.sourceStatus === "current" && coverage.calendarRevision === calendarRevision) {
    return Object.freeze({ outcome: "current" });
  }
  const year = firstRunInventoryHorizon(requestedAt, configuration.sourceInputs.propertyTimeZone);
  // Opening dates again after the calendar ended is the owner's choice (auto-open or setup).
  if (coverage.through < year.from) {
    return Object.freeze({ outcome: "not_room_change", reason: "calendar_ended" });
  }

  if (current.sourceStatus === "stale") {
    const other = current.sourceConflicts.find(({ code }) => !ROOM_CONFLICTS.has(code));
    if (other) return Object.freeze({ outcome: "not_room_change", reason: other.code });
    const roomSet = current.sourceConflicts.find(
      (conflict): conflict is Extract<typeof conflict, { code: "room_type_set_conflict" }> =>
        conflict.code === "room_type_set_conflict",
    );
    const roomTypeIds = [
      ...(roomSet?.currentRoomTypeIds ??
        configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId)),
    ].sort();
    const facts = new Map(
      (await ports.rooms.roomFacts.listRoomTypeFacts(propertyId)).map((room) => [
        room.roomTypeId,
        room,
      ]),
    );
    const bindings = new Map(
      configuration.sourceInputs.roomBindings.map((binding) => [binding.roomTypeId, binding]),
    );
    const roomTypeLimits: PmsStartingSellableLimitInput[] = [];
    for (const roomTypeId of roomTypeIds) {
      const capacity = await ports.rooms.roomCapacity.getRoomTypeCapacity(propertyId, roomTypeId);
      const fact = facts.get(roomTypeId);
      if (!fact || !capacity || capacity.activeUnitCount < 1) {
        return Object.freeze({ outcome: "not_room_change", reason: "room_capacity_unavailable" });
      }
      const binding = bindings.get(roomTypeId);
      // Fewer rooms than a night already holds can't be prepared: leave it to the hotel rather
      // than save a calendar whose nights fail.
      if (
        binding &&
        capacity.activeUnitCount < binding.physicalCapacityCount &&
        (await nightsHoldMoreThan(
          ports.pool,
          propertyId,
          roomTypeId,
          capacity.activeUnitCount,
          year.from,
        ))
      ) {
        return Object.freeze({ outcome: "not_room_change", reason: "room_capacity_protected" });
      }
      roomTypeLimits.push({
        roomTypeId,
        expectedRoomFactsRevision: fact.roomFactsRevision,
        expectedRoomUnitsRevision: capacity.roomUnitsRevision,
        startingSellableLimitCount: startingSellableLimit(binding, capacity.activeUnitCount),
      });
    }
    const proposal = parsePmsOperatingCalendarProposalRequest({
      expectedCalendarRevision: calendarRevision,
      expectedPropertyProfileRevision: await readProfileRevision(ports.pool, propertyId),
      schedule: configuration.schedule,
      defaultMinimumStayNights: configuration.defaultMinimumStayNights,
      roomTypeLimits,
    });
    const scope = { organizationId: actor.organizationId, propertyId };
    const previewCommand =
      proposal && parsePreviewPmsOperatingCalendarImpactCommand({ ...proposal, ...scope, audit });
    if (!proposal || !previewCommand) {
      return Object.freeze({ outcome: "failed", step: "preview", error: "proposal_invalid" });
    }
    const preview = await ports.preview.previewOperatingCalendarImpact(previewCommand);
    if (!preview.ok)
      return Object.freeze({ outcome: "failed", step: "preview", error: preview.error });
    const command = parseUpsertPmsOperatingCalendarCommand({
      ...proposal,
      ...scope,
      impactConfirmation: preview.preview.confirmation,
      // Each attempt is its own save; the expected revision keeps two of them from both landing.
      idempotencyKey: `pms.calendar-room-refresh.${randomUUID()}`,
      audit,
    });
    if (!command) {
      return Object.freeze({ outcome: "failed", step: "save", error: "command_invalid" });
    }
    const saved = await ports.calendar.upsertOperatingCalendar(command);
    if (!saved.ok) return Object.freeze({ outcome: "failed", step: "save", error: saved.error });
    calendarRevision = saved.response.configuration.calendarRevision;
    savedCalendar = true;
  } else {
    // A calendar saved in setup whose nights were never prepared: only while every night still
    // fits its room type's rooms.
    for (const binding of configuration.sourceInputs.roomBindings) {
      if (
        await nightsHoldMoreThan(
          ports.pool,
          propertyId,
          binding.roomTypeId,
          binding.physicalCapacityCount,
          year.from,
        )
      ) {
        return Object.freeze({ outcome: "not_room_change", reason: "room_capacity_protected" });
      }
    }
  }

  const horizon = {
    from: year.from,
    through: coverage.through < year.through ? coverage.through : year.through,
  };
  const materialized = await ports.materialization.materializeInventory({
    organizationId: actor.organizationId,
    propertyId,
    configurationSource: createPmsOperatingCalendarSourceRevision(propertyId, calendarRevision),
    expectedMaterializedRevision: calendarRevision,
    horizon,
    // Per attempt, so a failure isn't replayed once its cause is fixed.
    idempotencyKey: `pms.calendar-room-refresh.inventory.${randomUUID()}`,
    audit,
  });
  if (!materialized.ok) {
    return Object.freeze({ outcome: "failed", step: "inventory", error: materialized.error });
  }
  return Object.freeze({ outcome: "refreshed", calendarRevision, savedCalendar });
}

/** A limit the owner left at "every room" follows the new count; a lower one stays, capped at the
 * rooms there are (the rule pmsPhysicalRoomInventory uses for one added or retired room). A new
 * room type sells all of them. */
export function startingSellableLimit(
  binding: PmsOperatingCalendarRoomBinding | undefined,
  activeUnitCount: number,
): number {
  if (!binding || binding.startingSellableLimitCount === binding.physicalCapacityCount) {
    return activeUnitCount;
  }
  return Math.min(binding.startingSellableLimitCount, activeUnitCount);
}

export type PmsOperatingCalendarRoomRefreshCandidate = Readonly<{
  propertyId: string;
  organizationId: string;
  userId: string;
}>;

/**
 * Live hotels whose calendar is behind their rooms: an active room type with rooms that the
 * latest calendar doesn't list or lists with an older room count, a listed room type that is
 * gone, or a calendar saved in setup whose nights were never prepared. Each
 * comes with the last person who saved
 * its calendar and may still manage it, who the hourly repair runs as (never anyone else, as for
 * VAY-2350's background page refresh). Left out, so they don't come back every hour: hotels the
 * repair can't fix (a room type without rooms, a new time zone, an ended calendar) and hotels
 * without such a person.
 */
export async function findPmsOperatingCalendarRoomRefreshCandidates(
  pool: Queryable,
  limit: number,
  /** Only these hotels (a run limited to some of them); all live hotels when left out. */
  propertyIds?: readonly string[],
): Promise<readonly PmsOperatingCalendarRoomRefreshCandidate[]> {
  const result = await pool.query<PmsOperatingCalendarRoomRefreshCandidate>(
    `SELECT property.id::text AS "propertyId", latest.organization_id::text AS "organizationId",
            saver.created_by_user_id::text AS "userId"
     FROM hotel_catalog.properties property
     JOIN pms.inventory_materialization_coverage coverage ON coverage.property_id = property.id
     JOIN LATERAL (
       SELECT organization_id, calendar_revision, property_time_zone
       FROM pms.operating_calendar_revisions
       WHERE property_id = property.id ORDER BY calendar_revision DESC LIMIT 1
     ) latest ON TRUE
     JOIN LATERAL (
       SELECT revision.created_by_user_id
       FROM pms.operating_calendar_revisions revision
       JOIN identity.users actor ON actor.id = revision.created_by_user_id AND actor.status = 'active'
       JOIN identity.organization_memberships membership
         ON membership.organization_id = latest.organization_id AND membership.user_id = actor.id
        AND membership.status = 'active'
       JOIN identity.role_permission_grants permission_grant
         ON permission_grant.organization_kind = 'hotel_group'
        AND permission_grant.role_key = membership.role_key
        AND permission_grant.permission_key = $3
       WHERE revision.property_id = property.id
       ORDER BY revision.calendar_revision DESC LIMIT 1
     ) saver ON TRUE
     JOIN hotel_catalog.property_locations location
       ON location.property_id = property.id AND location.timezone = latest.property_time_zone
     WHERE property.lifecycle_status = 'active'
       AND ($2::uuid[] IS NULL OR property.id = ANY($2::uuid[]))
       AND coverage.coverage_through >= current_date
       AND NOT EXISTS (
         SELECT 1 FROM pms.room_types room
         WHERE room.property_id = property.id AND room.active IS TRUE
           AND NOT EXISTS (
             SELECT 1 FROM pms.room_type_closures closure
             WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pms.rooms unit
             WHERE unit.property_id = room.property_id AND unit.room_type_id = room.id
               AND unit.status <> 'retired'
           )
       )
       AND (
         coverage.calendar_revision < latest.calendar_revision
         OR EXISTS (
           SELECT 1 FROM pms.room_types room
           LEFT JOIN pms.operating_calendar_room_bindings binding
             ON binding.property_id = room.property_id AND binding.room_type_id = room.id
            AND binding.calendar_revision = latest.calendar_revision
           WHERE room.property_id = property.id AND room.active IS TRUE
             AND NOT EXISTS (
               SELECT 1 FROM pms.room_type_closures closure
               WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
             )
             AND (
               binding.room_type_id IS NULL
               OR binding.source_room_units_revision <> room.room_units_revision
             )
         )
         OR EXISTS (
           SELECT 1 FROM pms.operating_calendar_room_bindings binding
           LEFT JOIN pms.room_types room
             ON room.property_id = binding.property_id AND room.id = binding.room_type_id
            AND room.active IS TRUE
           WHERE binding.property_id = property.id
             AND binding.calendar_revision = latest.calendar_revision
             AND (
               room.id IS NULL
               OR EXISTS (
                 SELECT 1 FROM pms.room_type_closures closure
                 WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
               )
             )
         )
       )
     ORDER BY property.id
     LIMIT $1`,
    [limit, propertyIds ? [...propertyIds] : null, PMS_OPERATING_CALENDAR_AUTHORIZATION.permission],
  );
  return result.rows;
}

export type PmsOperatingCalendarRoomRepairSummary = Readonly<{
  candidates: number;
  refreshed: number;
  unchanged: number;
  /** Hotels tried a second time after a deadlock or lock wait with another writer. */
  retried: number;
  failed: readonly Readonly<{ propertyId: string; outcome: string; detail: unknown }>[];
}>;

const LOCK_CONFLICT_RETRY_PAUSE_MS = 2_000;

/** The hourly self-repair: brings each candidate hotel's calendar up to its rooms, one at a time. */
export async function repairPmsOperatingCalendarRooms(
  ports: PmsOperatingCalendarRoomRefreshPorts,
  input: {
    limit: number;
    runId: string;
    propertyIds?: readonly string[];
    retryPauseMs?: number;
  },
): Promise<PmsOperatingCalendarRoomRepairSummary> {
  const candidates = await findPmsOperatingCalendarRoomRefreshCandidates(
    ports.pool,
    input.limit,
    input.propertyIds,
  );
  let refreshed = 0;
  let unchanged = 0;
  let retried = 0;
  const failed: { propertyId: string; outcome: string; detail: unknown }[] = [];
  for (const candidate of candidates) {
    const refresh = () =>
      refreshPmsOperatingCalendarRooms(ports, {
        ...candidate,
        requestId: `pms.calendar-room-refresh.scheduler:${input.runId}:${candidate.propertyId}`,
        correlationId: input.runId,
      });
    try {
      let result: PmsOperatingCalendarRoomRefreshResult;
      try {
        result = await refresh();
      } catch (error) {
        // A deadlock or lock wait with another writer (VAY-2469: the 5-minute price re-publish)
        // left nothing behind, so the hotel gets one more try after a short pause. A second one,
        // or any other error, waits for the next hour.
        if (!lockConflict(error)) throw error;
        retried += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, input.retryPauseMs ?? LOCK_CONFLICT_RETRY_PAUSE_MS),
        );
        result = await refresh();
      }
      if (result.outcome === "refreshed") refreshed += 1;
      else if (result.outcome === "failed") {
        failed.push({
          propertyId: candidate.propertyId,
          outcome: result.step,
          detail: result.error,
        });
      } else if (result.outcome === "not_room_change") {
        failed.push({
          propertyId: candidate.propertyId,
          outcome: result.outcome,
          detail: result.reason,
        });
      } else unchanged += 1;
    } catch (error) {
      failed.push({
        propertyId: candidate.propertyId,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze({ candidates: candidates.length, refreshed, unchanged, retried, failed });
}

/** PostgreSQL's deadlock_detected and lock_not_available (lock_timeout). */
function lockConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "55P03";
}

export type PmsRoomChangeCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  audit: RoomFactsCommandAudit;
}>;

/**
 * Wraps a room command so the calendar catches up before the response. "Total rooms" adds rooms
 * and then names each one, and every name moves the room count's revision, so the calendar waits
 * while the room type still has rooms without a confirmed name: one save per room form, not one
 * per room. It also runs after a refused command, such as a single room change refused because the
 * calendar was behind, so trying again works. The room change itself has already committed or
 * failed: a calendar that can't follow is logged, never an error, and the hourly repair tries again.
 */
export function followRoomChangesInCalendar<
  Command extends PmsRoomChangeCommand,
  Result extends { ok: boolean },
>(
  run: (command: Command) => Promise<Result>,
  ports: PmsOperatingCalendarRoomRefreshPorts,
  log: (fields: Record<string, unknown>, message: string) => void,
): (command: Command) => Promise<Result> {
  return async (command) => {
    const result = await run(command);
    if (command.audit.actor.kind !== "user") return result;
    try {
      if (await roomsAwaitNames(ports.pool, command.propertyId, command.roomTypeId)) return result;
      const refreshed = await refreshPmsOperatingCalendarRooms(ports, {
        organizationId: command.organizationId,
        propertyId: command.propertyId,
        userId: command.audit.actor.userId,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId,
      });
      if (refreshed.outcome === "failed" || refreshed.outcome === "not_room_change") {
        log(
          { propertyId: command.propertyId, ...refreshed },
          "PMS calendar did not follow a room change",
        );
      }
    } catch (error) {
      log(
        { propertyId: command.propertyId, err: error },
        "PMS calendar did not follow a room change",
      );
    }
    return result;
  };
}

async function readCoverage(
  pool: Queryable,
  propertyId: string,
): Promise<{ calendarRevision: number; through: string } | null> {
  const row = (
    await pool.query<{ calendarRevision: number | string; through: string }>(
      `SELECT calendar_revision AS "calendarRevision", coverage_through::text AS through
       FROM pms.inventory_materialization_coverage WHERE property_id = $1::uuid`,
      [propertyId],
    )
  ).rows[0];
  return row ? { calendarRevision: Number(row.calendarRevision), through: row.through } : null;
}

/** Active rooms of the room type without a confirmed name, as the auto-open scheduler counts them. */
async function roomsAwaitNames(
  pool: Queryable,
  propertyId: string,
  roomTypeId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM pms.rooms
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND status <> 'retired'
       AND (operational_label_status <> 'verified' OR room_number IS NULL)
     LIMIT 1`,
    [propertyId, roomTypeId],
  );
  return result.rows.length > 0;
}

async function nightsHoldMoreThan(
  pool: Queryable,
  propertyId: string,
  roomTypeId: string,
  rooms: number,
  from: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND stay_date >= $4::date
       AND (assigned_count + blocked_count > $3 OR COALESCE(manual_sellable_limit_count, 0) > $3
         OR COALESCE(channel_sellable_limit_count, 0) > $3)
     LIMIT 1`,
    [propertyId, roomTypeId, rooms, from],
  );
  return result.rows.length > 0;
}

async function readProfileRevision(pool: Queryable, propertyId: string): Promise<number> {
  const row = (
    await pool.query<{ profileRevision: number | string }>(
      `SELECT profile_revision AS "profileRevision" FROM hotel_catalog.properties WHERE id = $1::uuid`,
      [propertyId],
    )
  ).rows[0];
  if (!row) throw new Error("Property profile revision is unavailable");
  return Number(row.profileRevision);
}
