import {
  parseUpsertPmsOperatingCalendarCommand,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgPmsCalendarAutoOpenWorkerStore,
  runPmsCalendarAutoOpenWorkerOnce,
} from "../jobs/pmsCalendarAutoOpenWorker.js";
import {
  PMS_CALENDAR_AUTO_OPEN_QUEUE,
  createPgPmsCalendarAutoOpenSchedulerStore,
} from "../jobs/pmsChannexScheduler.js";
import type { PmsRoomTypeRetireCommand } from "../routes/pmsOperations.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { createPgPmsLinkedInventoryGroupCommandRepository } from "./pmsLinkedInventoryGroupRepository.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarImpactService } from "./pmsOperatingCalendarImpact.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { refreshPmsOperatingCalendarRooms } from "./pmsOperatingCalendarRoomRefresh.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { createPgPmsPhysicalRoomManagementRepository } from "./pmsPhysicalRoomManagementRepository.js";
import { readPmsRoomClosureState } from "./pmsRoomClosureState.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";

// VAY-2132: one Delete retires the units, closes the future nights and takes the room out of the calendar.
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const acceptedAt = "2026-08-04T10:00:00.000Z";
let organizationId: string = randomUUID();
let propertyId: string = randomUUID();
let actorUserId: string = randomUUID();
let roomTypeA: string = randomUUID();
let roomTypeB: string = randomUUID();
let roomTypeC: string = randomUUID();
const roleKey = `room_delete_${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL room type Delete with cleanup", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const profileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
    max: 2,
  });
  const roomEvidence = createPgPmsRoomFactsReadModel({
    connectionString,
    max: 2,
    now: () => new Date(acceptedAt),
  });
  const calendar = createPgPmsOperatingCalendarCommandRepository({
    connectionString,
    max: 2,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    impactConfirmation: { verifyLockedImpactConfirmation: async () => null },
    now: () => new Date(acceptedAt),
  });
  const calendarRead = createPgPmsOperatingCalendarReadModel({
    connectionString,
    max: 2,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
  });
  const readRepository = createTargetPmsOperationsReadRepository({ connectionString });
  let cleanupEnabled = true;
  const rooms = createTargetPmsOperationsCommandRepository({
    connectionString,
    readRepository,
    now: () => new Date(acceptedAt),
    roomTypeDeleteCleanup: () => cleanupEnabled,
  });
  const units = createPgPmsPhysicalRoomManagementRepository({
    connectionString,
    now: () => new Date(acceptedAt),
  });
  const linkedRooms = createPgPmsLinkedInventoryGroupCommandRepository({
    connectionString,
    now: () => new Date(acceptedAt),
  });

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(connectionString).pathname))
      throw new Error("Test database required");
    await admin.connect();
  });
  beforeEach(async () => {
    [organizationId, propertyId, actorUserId, roomTypeA, roomTypeB, roomTypeC] = Array.from(
      { length: 6 },
      () => randomUUID(),
    ) as [string, string, string, string, string, string];
    cleanupEnabled = true;
    await seedAuthorizedProperty();
    await seedRooms();
    expect(await calendar.upsertOperatingCalendar(calendarCommand())).toMatchObject({ ok: true });
    await materialize();
    await seedPublicOffers();
  });
  afterAll(async () => {
    await units.close();
    await linkedRooms.close();
    await rooms.close?.();
    await readRepository.close?.();
    await calendarRead.close();
    await calendar.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });

  it("deletes a room type with its units, future nights and calendar place in one command", async () => {
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA)).toMatchObject({
      canRetire: true,
      blockers: [],
      cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 0, linkedGroups: 0 },
    });
    const command = deleteCommand(roomTypeA, "room-type-facts-v3");
    const deleted = await rooms.retireRoomType(command);
    expect(deleted).toMatchObject({
      ok: true,
      impact: {
        version: "room-type-facts-v4",
        canRetire: false,
        blockers: [],
        cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 0, linkedGroups: 0 },
      },
    });
    expect(await rooms.retireRoomType(command)).toEqual({ ...deleted, replayed: true });

    const state = await snapshot();
    expect(state.room).toEqual({ active: false, room_facts_revision: 4, room_units_revision: 6 });
    expect(state.unitStatuses).toEqual(["retired", "retired"]);
    expect(state.nights).toEqual(
      ["2026-08-04", "2026-08-05", "2026-08-06"].map((stay_date) => ({
        stay_date,
        status: "closed",
        available_count: 0,
        closure_source_revision: 1,
      })),
    );
    expect(state.bindings).toEqual(
      [roomTypeB, roomTypeC].sort().map((room_type_id) => ({ calendar_revision: 2, room_type_id })),
    );
    expect(state.coverage).toMatchObject({
      calendar_revision: 2,
      materialized_revision: 2,
      room_type_count: 2,
    });
    expect(state.receipts).toBe(1);
    expect(state.sellableOffers).toEqual(
      [roomTypeB, roomTypeC].sort().flatMap((id) => [id, id, id]),
    );
    expect(state.outbox).toEqual(
      expect.arrayContaining([
        "distribution.inventory-projection",
        "pms.channel-manager",
        "distribution.public-bookability",
      ]),
    );

    // The other rooms are untouched and the calendar is current: units can still change.
    expect(
      (
        await readPmsRoomClosureState(
          admin,
          { propertyId, roomTypeId: roomTypeB },
          new Date(acceptedAt),
        )
      )?.blockers,
    ).toEqual([]);
    expect(await calendarRead.getCurrentOperatingCalendarConfiguration(propertyId)).toMatchObject({
      sourceStatus: "current",
      sourceConflicts: [],
    });
    expect(
      await units.managePhysicalRoom({
        action: "create",
        organizationId,
        propertyId,
        roomTypeId: roomTypeB,
        expectedRevision: 8,
        idempotencyKey: randomUUID(),
        changes: { operationalLabel: "B-204", floor: "2" },
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: randomUUID(),
          correlationId: null,
          requestedAt: acceptedAt,
        },
      }),
    ).toMatchObject({ ok: true, response: { outcome: "created" } });
    // A guest can no longer book the deleted room; the other room still sells.
    await admin.query("BEGIN");
    try {
      expect(await reserve(admin, roomTypeA)).toBeNull();
      expect(await reserve(admin, roomTypeB)).not.toBeNull();
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("keeps the property's only room type, and writes nothing when blocked", async () => {
    for (const [roomTypeId, version] of [
      [roomTypeA, "room-type-facts-v3"],
      [roomTypeB, "room-type-facts-v4"],
    ] as const)
      expect(await rooms.retireRoomType(deleteCommand(roomTypeId, version))).toMatchObject({
        ok: true,
      });
    const before = await snapshot(roomTypeC);
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeC, "room-type-facts-v2")),
    ).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "room_type_retirement_blocked",
      impact: { canRetire: false, blockers: [{ code: "last_room_type", affectedCount: 1 }] },
    });
    expect(await snapshot(roomTypeC)).toEqual(before);
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      "channel_mapping",
      async () => {
        const externalId = randomUUID();
        await admin.query(
          `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
          VALUES ($1,'channex',$2,'active','enable')`,
          [propertyId, externalId],
        );
        await admin.query(
          `WITH connection AS (
            INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id)
            VALUES ($1,'channex','connected',$3) RETURNING id)
          INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
          SELECT $1,id,$2,'external-room' FROM connection`,
          [propertyId, roomTypeA, externalId],
        );
      },
    ],
    [
      "protected_inventory",
      () =>
        admin.query(
          `UPDATE pms.inventory_days SET manual_sellable_limit_count=0,effective_sellable_limit_count=0,
          available_count=0,manual_source_revision=1,inventory_revision=inventory_revision+1
          WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-05'`,
          [propertyId, roomTypeA],
        ),
    ],
    [
      "unavailable_units",
      () =>
        admin.query(
          "UPDATE pms.rooms SET status='out_of_order' WHERE property_id=$1 AND room_type_id=$2",
          [propertyId, roomTypeA],
        ),
    ],
  ])("is blocked by %s and writes nothing", async (code, setup) => {
    await setup();
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA)).toMatchObject({
      canRetire: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code })]),
    });
    const before = await snapshot();
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({
      ok: false,
      code: "room_type_retirement_blocked",
      impact: { blockers: expect.arrayContaining([expect.objectContaining({ code })]) },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("releases the room's blocks and takes it out of its linked rooms in the same Delete", async () => {
    const [unitId] = (
      await admin.query<{ id: string }>(
        "SELECT id::text FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2 ORDER BY id LIMIT 1",
        [propertyId, roomTypeA],
      )
    ).rows.map((row) => row.id);
    const blockAudit = deleteCommand(roomTypeA, "").audit;
    expect(
      await rooms.createRoomBlocks!({
        propertyId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        roomTypeId: roomTypeA,
        roomIds: [unitId!],
        startsOn: "2026-08-05",
        endsOn: "2026-08-06",
        reason: "Painting",
        audit: blockAudit,
      }),
    ).toMatchObject({ ok: true });
    const linkCommand = {
      propertyId,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      name: "Shared villa",
      memberRoomTypeIds: [roomTypeA, roomTypeB, roomTypeC],
      audit: blockAudit,
    };
    expect(await linkedRooms.create(linkCommand)).toMatchObject({ ok: true });
    // A block that started before today keeps its past nights.
    const pastStarted = (
      await admin.query<{ id: string }>(
        `INSERT INTO pms.room_blocks(property_id,room_type_id,starts_on,ends_on)
         VALUES ($1,$2,'2026-08-02','2026-08-04') RETURNING id::text`,
        [propertyId, roomTypeA],
      )
    ).rows[0]!.id;
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA)).toMatchObject({
      canRetire: true,
      blockers: [],
      cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 2, linkedGroups: 1 },
    });

    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({
      ok: true,
      impact: { cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 2, linkedGroups: 1 } },
    });
    const links = () =>
      admin
        .query<{ id: string; group: string | null }>(
          `SELECT id::text, linked_inventory_group_id::text AS "group" FROM pms.room_types
           WHERE property_id=$1 ORDER BY id`,
          [propertyId],
        )
        .then(({ rows }) => Object.fromEntries(rows.map((row) => [row.id, row.group])));
    const kept = await links();
    expect(kept[roomTypeA]).toBeNull();
    expect(kept[roomTypeB]).toBeTruthy();
    expect(kept[roomTypeC]).toBe(kept[roomTypeB]);
    const blocks = (
      await admin.query<{ id: string; status: string; endsOn: string }>(
        `SELECT id::text, status, ends_on::text AS "endsOn" FROM pms.room_blocks
         WHERE property_id=$1 AND room_type_id=$2 AND block_kind='manual'`,
        [propertyId, roomTypeA],
      )
    ).rows;
    expect(blocks.find((block) => block.id === pastStarted)).toMatchObject({
      status: "active",
      endsOn: "2026-08-03",
    });
    expect(blocks.filter((block) => block.id !== pastStarted)).toEqual([
      expect.objectContaining({ status: "released", endsOn: "2026-08-06" }),
    ]);

    // Deleting the next room ends the group of two that is left.
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeB, "room-type-facts-v4")),
    ).toMatchObject({ ok: true, impact: { cleanup: { linkedGroups: 1 } } });
    expect(await links()).toEqual({ [roomTypeA]: null, [roomTypeB]: null, [roomTypeC]: null });
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count FROM pms.linked_inventory_groups WHERE property_id=$1`,
          [propertyId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count FROM pms.inventory_days WHERE property_id=$1
           AND room_type_id=$2 AND (linked_stop_sell OR blocked_count<>0 OR status<>'open')`,
          [propertyId, roomTypeC],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("releases nothing when something else still stops the Delete", async () => {
    await admin.query(
      `INSERT INTO pms.room_blocks(property_id,room_type_id,starts_on,ends_on) VALUES ($1,$2,'2026-08-05','2026-08-06')`,
      [propertyId, roomTypeA],
    );
    await admin.query(
      "UPDATE pms.rooms SET status='out_of_order' WHERE property_id=$1 AND room_type_id=$2",
      [propertyId, roomTypeA],
    );
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({
      ok: false,
      code: "room_type_retirement_blocked",
      impact: {
        blockers: [expect.objectContaining({ code: "unavailable_units" })],
        cleanup: { roomBlocks: 1 },
      },
    });
    expect(
      (await admin.query("SELECT status FROM pms.room_blocks WHERE property_id=$1", [propertyId]))
        .rows,
    ).toEqual([{ status: "active" }]);
  });

  it("is blocked by a guest's hold that commits first", async () => {
    const holder = new pg.Client({ connectionString });
    await holder.connect();
    let deleting: ReturnType<typeof rooms.retireRoomType> | undefined;
    try {
      await holder.query("BEGIN");
      expect(await reserve(holder, roomTypeA)).not.toBeNull();
      deleting = rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3"));
      void deleting.catch(() => {});
      await waitForLockWaiter();
      await holder.query("COMMIT");
      expect(await deleting).toMatchObject({
        ok: false,
        code: "room_type_retirement_blocked",
        impact: { blockers: [expect.objectContaining({ code: "active_reservations" })] },
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([deleting]);
      await holder.end();
    }
    expect((await snapshot()).room).toMatchObject({ active: true });
  });

  it("refuses a stale version, a front-desk or foreign actor, and keeps today's Delete when off", async () => {
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v2")),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    await admin.query(
      `UPDATE identity.organization_resource_links SET relationship='front_desk'
       WHERE organization_id=$1 AND resource_id=$2::text`,
      [organizationId, propertyId],
    );
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({ ok: false, statusCode: 403, code: "room_type_delete_not_allowed" });
    cleanupEnabled = false;
    const impact = await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA);
    expect(impact).not.toHaveProperty("cleanup");
    // Today's check (server date; these fixture nights are in the past) still asks to retire the units.
    expect(impact?.blockers.map((blocker) => blocker.code)).toContain("active_physical_units");
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({ ok: false, code: "room_type_retirement_blocked" });
    expect((await snapshot()).room).toMatchObject({ active: true });
  });

  it("retires the units of a room type the calendar doesn't hold yet", async () => {
    const roomTypeD = await seedRoomOutsideCalendar(1);
    // The unbound room keeps the calendar out of date for the others until it is gone.
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA)).toMatchObject({
      canRetire: false,
      blockers: [expect.objectContaining({ code: "calendar_not_current" })],
    });
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeD)).toMatchObject({
      canRetire: true,
      blockers: [],
      cleanup: { physicalUnits: 1, futureNights: 0, roomBlocks: 0, linkedGroups: 0 },
    });
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeD, "room-type-facts-v1")),
    ).toMatchObject({ ok: true, impact: { cleanup: { physicalUnits: 1, futureNights: 0 } } });
    expect((await snapshot(roomTypeD)).unitStatuses).toEqual(["retired"]);
    expect((await snapshot(roomTypeD)).receipts).toBe(0);
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({ ok: true, impact: { cleanup: { physicalUnits: 2, futureNights: 3 } } });
  });

  it("retires a room type with nothing to clean up exactly as today, also for front desk", async () => {
    const roomTypeE = await seedRoomOutsideCalendar(0);
    await admin.query(
      `UPDATE identity.organization_resource_links SET relationship='front_desk'
       WHERE organization_id=$1 AND resource_id=$2::text`,
      [organizationId, propertyId],
    );
    const impact = await rooms.inspectRoomTypeRetirement(propertyId, roomTypeE);
    expect(impact).toMatchObject({ canRetire: true, blockers: [] });
    expect(impact).not.toHaveProperty("cleanup");
    const retired = await rooms.retireRoomType(deleteCommand(roomTypeE, "room-type-facts-v1"));
    expect(retired).toMatchObject({ ok: true, impact: { version: "room-type-facts-v2" } });
    expect(retired.ok && retired.impact).not.toHaveProperty("cleanup");
  });

  it("closes the nights from the property's local date", async () => {
    // 23:30 UTC is already the next day in Berlin: that night is the first one closed.
    const lateRooms = createTargetPmsOperationsCommandRepository({
      connectionString,
      readRepository,
      now: () => new Date("2026-08-04T23:30:00.000Z"),
      roomTypeDeleteCleanup: () => true,
    });
    try {
      expect(
        await lateRooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
      ).toMatchObject({ ok: true, impact: { cleanup: { futureNights: 2 } } });
    } finally {
      await lateRooms.close?.();
    }
    expect((await snapshot()).nights.map((night: { status: string }) => night.status)).toEqual([
      "open",
      "closed",
      "closed",
    ]);
  });

  // VAY-2497: auto-open opens nights through the month's end a year ahead; a room change prepares one
  // year, so the later nights sit after the covered range until auto-open runs again (VAY-2138).
  it("deletes a room added after auto-open right away, and auto-open still opens the later nights (VAY-2497)", async () => {
    const autoOpen = await enableAutoOpen();
    try {
      await autoOpen.run();
      expect(await coverage()).toEqual({ through: "2027-08-31", revision: 1, rooms: 3 });

      // Duplicate, then "Total rooms" and the room's name: the calendar follows the new room.
      const roomTypeD = await seedRoomOutsideCalendar(1);
      expect(await refreshCalendar()).toMatchObject({ outcome: "refreshed", savedCalendar: true });
      expect(await coverage()).toEqual({ through: "2027-08-04", revision: 2, rooms: 4 });
      expect(await nightsAfterCoverage()).toEqual(
        Object.fromEntries([roomTypeA, roomTypeB, roomTypeC, roomTypeD].map((id) => [id, 27])),
      );

      // The room closure command still protects those nights; the Delete closes them with the rest.
      const closure = (options?: { closeEmptyNightsAfterCoverage: boolean }) =>
        readPmsRoomClosureState(
          admin,
          { propertyId, roomTypeId: roomTypeD },
          new Date(acceptedAt),
          options,
        );
      expect((await closure())?.blockers).toEqual(["protected_inventory"]);
      expect((await closure({ closeEmptyNightsAfterCoverage: true }))?.blockers).toEqual([]);
      // 2026-08-04 through 2027-08-31.
      const cleanup = { physicalUnits: 1, futureNights: 393, roomBlocks: 0, linkedGroups: 0 };
      expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeD)).toMatchObject({
        canRetire: true,
        blockers: [],
        cleanup,
      });
      expect(
        await rooms.retireRoomType(deleteCommand(roomTypeD, "room-type-facts-v1")),
      ).toMatchObject({ ok: true, impact: { cleanup } });
      const deleted = await snapshot(roomTypeD);
      expect(deleted.room).toMatchObject({ active: false });
      expect(deleted.unitStatuses).toEqual(["retired"]);
      expect(deleted.nights).toHaveLength(393);
      expect(new Set(deleted.nights.map((night: { status: string }) => night.status))).toEqual(
        new Set(["closed"]),
      );
      expect(await coverage()).toEqual({ through: "2027-08-04", revision: 3, rooms: 3 });

      // Auto-open's next run takes the later nights back into the calendar without the room.
      await autoOpen.run();
      expect(await coverage()).toEqual({ through: "2027-08-31", revision: 3, rooms: 3 });
      expect(await nightsAfterCoverage()).toEqual({});
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS stale FROM pms.inventory_days
             WHERE property_id=$1 AND room_type_id<>$2 AND stay_date>='2026-08-04'
               AND calendar_revision<>3`,
            [propertyId, roomTypeD],
          )
        ).rows[0],
      ).toEqual({ stale: 0 });
    } finally {
      await autoOpen.close();
    }
  });

  it("still stops the Delete for a booking or a limit after the covered range (VAY-2497)", async () => {
    const autoOpen = await enableAutoOpen();
    try {
      await autoOpen.run();
      const roomTypeD = await seedRoomOutsideCalendar(1);
      expect(await refreshCalendar()).toMatchObject({ outcome: "refreshed" });

      // A limit on the new room's later night.
      const limit = (count: number | null) =>
        admin.query(
          `UPDATE pms.inventory_days SET manual_sellable_limit_count=$3::int,
             effective_sellable_limit_count=COALESCE($3::int,generated_sellable_limit_count),
             available_count=GREATEST(0,COALESCE($3::int,generated_sellable_limit_count)-assigned_count-blocked_count),
             manual_source_revision=manual_source_revision+1, inventory_revision=inventory_revision+1
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2027-08-20'`,
          [propertyId, roomTypeD, count],
        );
      await limit(0);
      expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeD)).toMatchObject({
        canRetire: false,
        blockers: [expect.objectContaining({ code: "protected_inventory", affectedCount: 1 })],
      });
      expect(
        await rooms.retireRoomType(deleteCommand(roomTypeD, "room-type-facts-v1")),
      ).toMatchObject({ ok: false, code: "room_type_retirement_blocked" });
      await limit(null);

      // A booked night of an existing room, still from the calendar before the room was added.
      await admin.query(
        `UPDATE pms.inventory_days SET assigned_count=assigned_count+1,
           available_count=CASE WHEN status='closed' OR linked_stop_sell THEN 0
             ELSE GREATEST(0,effective_sellable_limit_count-assigned_count-1-blocked_count) END,
           booking_source_revision=booking_source_revision+1, inventory_revision=inventory_revision+1
         WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2027-08-20' AND calendar_revision=1`,
        [propertyId, roomTypeA],
      );
      expect(
        (
          await readPmsRoomClosureState(
            admin,
            { propertyId, roomTypeId: roomTypeA },
            new Date(acceptedAt),
            { closeEmptyNightsAfterCoverage: true },
          )
        )?.blockers,
      ).toEqual(["protected_inventory"]);
      // Without a booking record behind it, the booked count reads as an out-of-date calendar.
      expect(
        await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
      ).toMatchObject({
        ok: false,
        code: "room_type_retirement_blocked",
        impact: { blockers: [expect.objectContaining({ code: "calendar_not_current" })] },
      });

      // Nothing else stops either room: the new one goes once its limit is gone.
      expect(
        await rooms.retireRoomType(deleteCommand(roomTypeD, "room-type-facts-v1")),
      ).toMatchObject({ ok: true, impact: { cleanup: { futureNights: 393 } } });
      expect((await snapshot()).room).toMatchObject({ active: true });

      // A migrated night without a calendar revision can't be closed, so it still refuses the
      // Delete instead of failing it.
      await admin.query(
        `INSERT INTO pms.inventory_days (property_id,room_type_id,stay_date,total_count,available_count)
         VALUES ($1,$2,'2027-09-05',1,1)`,
        [propertyId, roomTypeC],
      );
      expect(
        (
          await readPmsRoomClosureState(
            admin,
            { propertyId, roomTypeId: roomTypeC },
            new Date(acceptedAt),
            { closeEmptyNightsAfterCoverage: true },
          )
        )?.blockers,
      ).toEqual(["protected_inventory"]);
      expect(
        await rooms.retireRoomType(deleteCommand(roomTypeC, "room-type-facts-v2")),
      ).toMatchObject({
        ok: false,
        code: "room_type_retirement_blocked",
        impact: { blockers: [expect.objectContaining({ code: "calendar_not_current" })] },
      });
      expect((await snapshot(roomTypeC)).room).toMatchObject({ active: true });
    } finally {
      await autoOpen.close();
    }
  });

  /** Auto-open for this hotel only: other suites' hotels share the database. */
  async function enableAutoOpen() {
    await admin.query(
      `INSERT INTO pms.property_pricing_settings (property_id, currency) VALUES ($1::uuid, 'EUR')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.calendar_auto_open_settings
         (property_id, revision, enabled, mode, rolling_months, fixed_end_month)
       VALUES ($1::uuid, 1, TRUE, 'rolling', 12, NULL)`,
      [propertyId],
    );
    const scheduler = createPgPmsCalendarAutoOpenSchedulerStore({ connectionString });
    const worker = createPgPmsCalendarAutoOpenWorkerStore({
      connectionString,
      propertyProfileEvidence: profileEvidence,
    });
    const at = new Date(acceptedAt);
    const latestJob = async () =>
      (
        await admin.query<{ status: string }>(
          `SELECT status FROM platform.jobs WHERE property_id=$1 AND queue_name=$2
           ORDER BY created_at DESC LIMIT 1`,
          [propertyId, PMS_CALENDAR_AUTO_OPEN_QUEUE],
        )
      ).rows[0];
    return {
      async run() {
        const queued = await scheduler.withRunLock(async (session) => {
          const { candidates } = await session.findCalendarAutoOpenCandidates(at, 1000);
          const candidate = candidates.find((ready) => ready.propertyId === propertyId);
          if (!candidate) throw new Error("Expected the hotel to be ready for auto-open");
          return session.enqueueCalendarAutoOpenJob(candidate, {
            now: at,
            workerId: "vay-2497-test",
            correlationId: `vay-2497-${propertyId}`,
          });
        });
        expect(queued).toMatchObject({ ran: true, value: { createdNewJob: true } });
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const status = (await latestJob())?.status;
          if (status !== "pending" && status !== "running") break;
          await runPmsCalendarAutoOpenWorkerOnce({
            store: worker,
            workerId: "vay-2497-test",
            now: () => at,
          });
        }
        expect(await latestJob()).toEqual({ status: "succeeded" });
      },
      async close() {
        // Later suites' scheduler runs leave this hotel alone.
        await admin.query(
          `UPDATE pms.calendar_auto_open_settings SET enabled=FALSE WHERE property_id=$1::uuid`,
          [propertyId],
        );
        await worker.close?.();
        await scheduler.close();
      },
    };
  }

  /** What the room routes run after a room change (VAY-2469). */
  async function refreshCalendar() {
    const roomPorts = { roomFacts: roomEvidence, roomCapacity: roomEvidence };
    const preview = createPgPmsOperatingCalendarImpactService({
      connectionString,
      max: 2,
      confirmationSecret: "vay2497-room-type-delete-confirmation-secret",
      propertyProfileEvidence: profileEvidence,
      roomEvidence: roomPorts,
      now: () => new Date(acceptedAt),
    });
    const materialization = createPgPmsInventoryMaterializationRepository({
      connectionString,
      authorization: { authorizeInventoryMaterialization: async () => true },
      operatingCalendar: calendarRead,
      propertyProfileEvidence: profileEvidence,
      roomCapacity: roomEvidence,
      now: () => new Date(acceptedAt),
    });
    try {
      return await refreshPmsOperatingCalendarRooms(
        {
          pool: admin,
          calendarRead,
          rooms: roomPorts,
          preview,
          calendar,
          materialization,
          now: () => new Date(acceptedAt),
        },
        {
          organizationId,
          propertyId,
          userId: actorUserId,
          requestId: randomUUID(),
          correlationId: null,
        },
      );
    } finally {
      await Promise.all([preview.close(), materialization.close()]);
    }
  }

  async function coverage() {
    return (
      await admin.query(
        `SELECT coverage_through::text AS through, calendar_revision::int AS revision,
           room_type_count::int AS rooms
         FROM pms.inventory_materialization_coverage WHERE property_id=$1`,
        [propertyId],
      )
    ).rows[0];
  }

  /** Nights per room after the covered range that are not closed. */
  async function nightsAfterCoverage(): Promise<Record<string, number>> {
    const result = await admin.query<{ roomTypeId: string; nights: number }>(
      `SELECT day.room_type_id::text AS "roomTypeId", count(*)::int AS nights
       FROM pms.inventory_days day JOIN pms.inventory_materialization_coverage coverage
         ON coverage.property_id=day.property_id
       WHERE day.property_id=$1 AND day.stay_date>coverage.coverage_through AND day.status<>'closed'
       GROUP BY day.room_type_id`,
      [propertyId],
    );
    return Object.fromEntries(result.rows.map((row) => [row.roomTypeId, row.nights]));
  }

  async function seedRoomOutsideCalendar(unitCount: number): Promise<string> {
    const roomTypeId = randomUUID();
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES ($1::uuid, $2::uuid, 'Added later', '', '{"total":2,"adults":2,"children":0}'::jsonb,
        '{"beds":[{"type":"double","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":18,"unit":"sqm"}}'::jsonb, TRUE, 1, 1)`,
      [roomTypeId, propertyId],
    );
    for (let unit = 0; unit < unitCount; unit += 1)
      await admin.query(
        `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number, status, operational_label_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [randomUUID(), propertyId, roomTypeId, `D-40${unit}`],
      );
    return roomTypeId;
  }

  function deleteCommand(roomTypeId: string, expectedVersion: string): PmsRoomTypeRetireCommand {
    const commandId = randomUUID();
    return {
      propertyId,
      roomTypeId,
      commandId,
      idempotencyKey: commandId,
      expectedVersion,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: randomUUID(),
        requestedAt: acceptedAt,
        reason: "Delete synthetic room type",
      },
    };
  }

  function reserve(transaction: pg.Client, roomTypeId: string) {
    return createTargetPmsInventoryReservationPort().reserve({
      transaction,
      propertyId,
      roomTypeId,
      publicOfferKey: roomTypeId,
      quoteSessionId: randomUUID(),
      checkIn: "2026-08-04",
      checkOut: "2026-08-06",
      roomCount: 1,
      currency: "EUR",
      occurredAt: new Date(acceptedAt),
    });
  }

  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await admin.query(
        `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted LIMIT 1`,
      );
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected the Delete to wait on the guest's inventory lock");
  }

  async function snapshot(roomTypeId = roomTypeA) {
    const value = (
      await admin.query(
        `SELECT jsonb_build_object(
          'room',(SELECT jsonb_build_object('active',active,'room_facts_revision',room_facts_revision,
            'room_units_revision',room_units_revision) FROM pms.room_types WHERE property_id=$1 AND id=$2),
          'unitStatuses',(SELECT jsonb_agg(status ORDER BY status) FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2),
          'nights',(SELECT jsonb_agg(jsonb_build_object('stay_date',stay_date::text,'status',status,
            'available_count',available_count,'closure_source_revision',closure_source_revision) ORDER BY stay_date)
            FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2),
          'bindings',(SELECT jsonb_agg(jsonb_build_object('calendar_revision',calendar_revision,'room_type_id',room_type_id::text)
            ORDER BY calendar_revision,room_type_id) FROM pms.operating_calendar_room_bindings
            WHERE property_id=$1 AND calendar_revision=(SELECT max(calendar_revision)
              FROM pms.operating_calendar_revisions WHERE property_id=$1)),
          'coverage',(SELECT to_jsonb(coverage) FROM pms.inventory_materialization_coverage coverage WHERE property_id=$1),
          'receipts',(SELECT count(*) FROM pms.room_type_closures WHERE property_id=$1),
          'sellableOffers',(SELECT COALESCE(jsonb_agg(room_type_id::text ORDER BY room_type_id,stay_date),'[]')
            FROM distribution.public_room_offer_snapshots WHERE property_id=$1 AND sellable_publicly),
          'outbox',(SELECT COALESCE(jsonb_agg(DISTINCT destination),'[]') FROM platform.outbox_events WHERE property_id=$1),
          'keys',(SELECT count(*) FROM platform.idempotency_keys WHERE property_id=$1),
          'audit',(SELECT count(*) FROM platform.product_audit_events WHERE property_id=$1)
        ) AS value`,
        [propertyId, roomTypeId],
      )
    ).rows[0].value;
    return value;
  }

  async function materialize(): Promise<void> {
    const configured = await calendarRead.getCurrentOperatingCalendarConfiguration(propertyId);
    if (!configured?.configuration) throw new Error("Expected configured calendar");
    const materializer = createPgPmsInventoryMaterializationRepository({
      connectionString,
      authorization: { authorizeInventoryMaterialization: async () => true },
      operatingCalendar: calendarRead,
      propertyProfileEvidence: profileEvidence,
      roomCapacity: roomEvidence,
      now: () => new Date(acceptedAt),
    });
    try {
      expect(
        await materializer.materializeInventory({
          organizationId,
          propertyId,
          configurationSource: configured.configuration.source,
          expectedMaterializedRevision: 1,
          horizon: { from: "2026-08-04", through: "2026-08-06" },
          idempotencyKey: randomUUID(),
          audit: calendarCommand().audit,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await materializer.close();
    }
  }

  async function seedPublicOffers(): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
      (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
      VALUES ($1::uuid,$1::text,'VAY-2132 Delete',$1::text,'en',ARRAY['en'],'complete')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
      (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness)
      VALUES ($1::uuid,$1::text,$1::text,'https://example.test','https://example.test','Europe/Berlin','EUR',ARRAY['EUR'],'public','fresh','{"status":"ready"}')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO distribution.public_room_offer_snapshots
      (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,currency,freshness_status,payment_options)
      SELECT property_id,room_type_id,stay_date,room_type_id::text,available_count,100,'EUR','fresh',ARRAY['pay_at_property']
      FROM pms.inventory_days WHERE property_id=$1`,
      [propertyId],
    );
  }

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2132 Delete', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2132 Delete', $2, 'active')`,
      [organizationId, organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, $2, 'VAY-2132 Delete', 7)`,
      [propertyId, propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone) VALUES ($1::uuid, 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage') ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedRooms(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES
       ($1::uuid, $3::uuid, 'TEST ONLY delete me', '', '{"total":2,"adults":2,"children":0}'::jsonb,
        '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":20,"unit":"sqm"}}'::jsonb, TRUE, 3, 5),
       ($2::uuid, $3::uuid, 'Loft Suite', '', '{"total":4,"adults":3,"children":1}'::jsonb,
        '{"beds":[{"type":"king","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":40,"unit":"sqm"}}'::jsonb, TRUE, 4, 8),
       ($4::uuid, $3::uuid, 'Garden Room', '', '{"total":2,"adults":2,"children":0}'::jsonb,
        '{"beds":[{"type":"double","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":18,"unit":"sqm"}}'::jsonb, TRUE, 2, 3)`,
      [roomTypeA, roomTypeB, propertyId, roomTypeC],
    );
    for (const [roomTypeId, roomNumber] of [
      [roomTypeA, "A-101"],
      [roomTypeA, "A-102"],
      [roomTypeB, "B-201"],
      [roomTypeB, "B-202"],
      [roomTypeB, "B-203"],
      [roomTypeC, "C-301"],
    ] as const)
      await admin.query(
        `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number, status, operational_label_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [randomUUID(), propertyId, roomTypeId, roomNumber],
      );
  }
});

function calendarCommand(): UpsertPmsOperatingCalendarCommand {
  const parsed = parseUpsertPmsOperatingCalendarCommand({
    organizationId,
    propertyId,
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "recurring", periods: [{ startsOn: "07-01", endsOn: "03-31" }] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: [
      {
        roomTypeId: roomTypeA,
        expectedRoomFactsRevision: 3,
        expectedRoomUnitsRevision: 5,
        startingSellableLimitCount: 2,
      },
      {
        roomTypeId: roomTypeB,
        expectedRoomFactsRevision: 4,
        expectedRoomUnitsRevision: 8,
        startingSellableLimitCount: 3,
      },
      {
        roomTypeId: roomTypeC,
        expectedRoomFactsRevision: 2,
        expectedRoomUnitsRevision: 3,
        startingSellableLimitCount: 1,
      },
    ],
    impactConfirmation: {
      contractVersion: "pms-operating-calendar-impact.v1",
      proposalFingerprint: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      token: "integration-test-token",
      issuedAt: acceptedAt,
      expiresAt: "2026-08-04T10:15:00.000Z",
    },
    idempotencyKey: `vay2132-calendar-${propertyId}`,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `req-vay2132-${propertyId}`,
      correlationId: `corr-vay2132-${propertyId}`,
      requestedAt: acceptedAt,
    },
  });
  if (!parsed) throw new Error("Invalid calendar command fixture");
  return parsed;
}
