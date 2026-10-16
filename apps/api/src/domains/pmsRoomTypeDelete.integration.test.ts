import {
  parseUpsertPmsOperatingCalendarCommand,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsRoomTypeRetireCommand } from "../routes/pmsOperations.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { createPgPmsLinkedInventoryGroupCommandRepository } from "./pmsLinkedInventoryGroupRepository.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
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
    expect(await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA)).toMatchObject({
      canRetire: true,
      blockers: [],
      cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 1, linkedGroups: 1 },
    });

    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({
      ok: true,
      impact: { cleanup: { physicalUnits: 2, futureNights: 3, roomBlocks: 1, linkedGroups: 1 } },
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
    expect(
      (
        await admin.query(
          "SELECT status FROM pms.room_blocks WHERE property_id=$1 AND room_type_id=$2 AND block_kind='manual'",
          [propertyId, roomTypeA],
        )
      ).rows,
    ).toEqual([{ status: "released" }]);

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
    ).toMatchObject({ ok: false, statusCode: 403, code: "missing_permission" });
    cleanupEnabled = false;
    const impact = await rooms.inspectRoomTypeRetirement(propertyId, roomTypeA);
    expect(impact).not.toHaveProperty("cleanup");
    expect(impact?.blockers.map((blocker) => blocker.code)).toEqual([
      "active_physical_units",
      "future_inventory",
      "active_publication",
    ]);
    expect(
      await rooms.retireRoomType(deleteCommand(roomTypeA, "room-type-facts-v3")),
    ).toMatchObject({ ok: false, code: "room_type_retirement_blocked" });
    expect((await snapshot()).room).toMatchObject({ active: true });
  });

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
