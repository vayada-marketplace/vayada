import { readPmsRoomClosureState } from "./pmsRoomClosureState.js";
import { retireClosingRoomUnits } from "./pmsRoomClosureUnits.js";
import { appendRoomClosureCalendar, closeRoomClosureInventory } from "./pmsRoomClosureCalendar.js";
import { createPgPmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import {
  parseUpsertPmsOperatingCalendarCommand,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { createPgPmsOperatingCalendarImpactService } from "./pmsOperatingCalendarImpact.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = randomUUID();
const propertyId = randomUUID();
const actorUserId = randomUUID();
const roomTypeA = randomUUID();
const roomTypeB = randomUUID();
const acceptedAt = "2026-08-04T10:00:00.000Z";
const roleKey = `closure_${randomUUID()}`;
const impactConfirmation = {
  async verifyLockedImpactConfirmation() {
    return null;
  },
};

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL room closure calendar fence", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const profileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
    max: 4,
  });
  const roomEvidence = createPgPmsRoomFactsReadModel({
    connectionString,
    max: 4,
    now: () => new Date(acceptedAt),
  });
  const impact = createPgPmsOperatingCalendarImpactService({
    connectionString,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    confirmationSecret: "closure-integration-only-confirmation-secret",
    now: () => new Date(acceptedAt),
  });
  const repository = createPgPmsOperatingCalendarCommandRepository({
    connectionString,
    max: 4,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    impactConfirmation,
    now: () => new Date(acceptedAt),
  });
  const readModel = createPgPmsOperatingCalendarReadModel({
    connectionString,
    max: 3,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
  });

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(connectionString).pathname))
      throw new Error("Test database required");
    await admin.connect();
    await seedAuthorizedProperty();
    await seedRooms();
  });
  afterAll(async () => {
    // Retain audit/job history without leaving runnable synthetic delivery work.
    await admin.query(
      "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
      [propertyId],
    );
    await admin.query(
      "UPDATE platform.jobs SET status='canceled',finished_at=now() WHERE property_id=$1 AND queue_name='pms.channex.management' AND status='pending'",
      [propertyId],
    );
    await impact.close();
    await readModel.close();
    await repository.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });
  it("rejects a pre-closure room set and accepts only remaining operating rooms", async () => {
    expect(await repository.upsertOperatingCalendar(command("before"))).toMatchObject({ ok: true });
    const configured = await readModel.getCurrentOperatingCalendarConfiguration(propertyId);
    if (!configured?.configuration) throw new Error("Expected configured calendar");
    const materializer = createPgPmsInventoryMaterializationRepository({
      connectionString,
      authorization: { authorizeInventoryMaterialization: async () => true },
      operatingCalendar: readModel,
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
          audit: command("materialize").audit,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await materializer.close();
    }
    const preflight = () =>
      readPmsRoomClosureState(admin, { propertyId, roomTypeId: roomTypeA }, new Date(acceptedAt));
    expect(await preflight()).toMatchObject({
      blockers: [],
      cutoffDate: "2026-08-04",
      futureInventoryDays: 3,
    });
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE pms.inventory_days SET manual_sellable_limit_count=0,
        effective_sellable_limit_count=0,available_count=0,manual_source_revision=1,inventory_revision=2
        WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-04'`,
        [propertyId, roomTypeA],
      );
      expect((await preflight())?.blockers).toContain("protected_inventory");
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("BEGIN");
    try {
      await admin.query(
        `DELETE FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2
        AND stay_date='2026-08-06'`,
        [propertyId, roomTypeB],
      );
      expect((await preflight())?.blockers).toContain("coverage_incomplete");
    } finally {
      await admin.query("ROLLBACK");
    }
    for (const [mutation, blocker] of [
      [
        "ALTER TABLE pms.inventory_days ADD COLUMN unexpected_source_revision integer NOT NULL DEFAULT 0",
        "unknown_inventory_owner",
      ],
      [
        "UPDATE pms.rooms SET status='out_of_order' WHERE property_id=$1 AND room_type_id=$2",
        "protected_units",
      ],
      [
        "UPDATE pms.room_types SET active=false WHERE property_id=$1 AND id<>$2",
        "last_operating_room",
      ],
      [
        "INSERT INTO pms.room_blocks(property_id,room_type_id,starts_on,ends_on) VALUES ($1,$2,'2026-08-04','2026-08-06')",
        "active_blocks",
      ],
    ]) {
      await admin.query("BEGIN");
      try {
        await admin.query(mutation!, mutation!.includes("$1") ? [propertyId, roomTypeA] : []);
        expect((await preflight())?.blockers).toContain(blocker);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await admin.query("BEGIN");
    try {
      const closureScope = { propertyId, roomTypeId: roomTypeA, commandId: randomUUID() };
      await expect(retireClosingRoomUnits(admin, closureScope)).rejects.toThrow(
        "requires its receipt",
      );
      const history = await admin.query<{ id: string; room_id: string }>(
        `INSERT INTO pms.room_blocks(property_id,room_type_id,room_id,starts_on,ends_on,status)
        SELECT property_id,room_type_id,id,'2026-08-01','2026-08-02','released'
        FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2 RETURNING id,room_id`,
        [propertyId, roomTypeA],
      );
      expect((await preflight())?.blockers).toEqual([]);
      const otherUnits = await admin.query(
        "SELECT * FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2 ORDER BY id",
        [propertyId, roomTypeB],
      );
      await admin.query(
        `INSERT INTO pms.room_type_closures
        (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,
         expected_room_units_revision,previous_calendar_revision,closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
        VALUES ($1,$2,$3,$4,3,5,1,2,'2026-08-05',$5,$6)`,
        [
          propertyId,
          roomTypeA,
          closureScope.commandId,
          "c".repeat(64),
          "2026-08-05T10:00:00.000Z",
          actorUserId,
        ],
      );
      await expect(retireClosingRoomUnits(admin, closureScope)).rejects.toThrow("remain protected");
      const selectedBefore = (
        await admin.query(
          "SELECT * FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 ORDER BY stay_date",
          [propertyId, roomTypeA],
        )
      ).rows;
      expect(selectedBefore.map((day) => day.status)).toEqual(["open", "open", "open"]);
      expect(await closeRoomClosureInventory(admin, closureScope)).toBe(2);
      expect(await closeRoomClosureInventory(admin, closureScope)).toBe(0);
      const selectedAfter = (
        await admin.query(
          "SELECT * FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 ORDER BY stay_date",
          [propertyId, roomTypeA],
        )
      ).rows;
      expect(selectedAfter).toEqual(
        selectedBefore.map((day, index) =>
          index === 0
            ? day
            : {
                ...day,
                status: "closed",
                available_count: 0,
                closure_source_revision: 1,
                inventory_revision: day.inventory_revision + 1,
              },
        ),
      );
      const retired = await retireClosingRoomUnits(admin, closureScope);
      expect(retired).toEqual({
        retiredUnitIds: history.rows.map((row) => row.room_id).sort(),
        roomUnitsRevision: 6,
      });
      expect(
        (
          await admin.query(
            "SELECT id,room_id FROM pms.room_blocks WHERE property_id=$1 ORDER BY id",
            [propertyId],
          )
        ).rows,
      ).toEqual([...history.rows].sort((a, b) => a.id.localeCompare(b.id)));
      expect(
        (
          await admin.query(
            "SELECT * FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2 ORDER BY id",
            [propertyId, roomTypeB],
          )
        ).rows,
      ).toEqual(otherUnits.rows);
      await expect(retireClosingRoomUnits(admin, closureScope)).rejects.toThrow(
        "requires its receipt",
      );
      const beforeDays = (
        await admin.query(
          "SELECT to_jsonb(day) AS value FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date",
          [propertyId],
        )
      ).rows;
      const beforeCoverage = (
        await admin.query(
          "SELECT * FROM pms.inventory_materialization_coverage WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0];
      const events = {
        idempotencyId: randomUUID(),
        domainEventId: randomUUID(),
        outboxEventId: randomUUID(),
      };
      await admin.query(
        `INSERT INTO platform.idempotency_keys
        (id,operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
        VALUES ($1,'pms','room_type.close',$2,$2,'property',$3,now()+interval '1 day')`,
        [events.idempotencyId, "d".repeat(64), propertyId],
      );
      await admin.query(
        `INSERT INTO platform.domain_events
        (id,source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
        VALUES ($1::uuid,'pms',$1::text,'pms.room_type.closed',now(),'property',$2,'pms','room_type',$3,$4)`,
        [
          events.domainEventId,
          propertyId,
          roomTypeA,
          JSON.stringify({ commandId: closureScope.commandId }),
        ],
      );
      await admin.query(
        `INSERT INTO platform.outbox_events
        (id,domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id)
        VALUES ($1::uuid,$2,$1::text,'distribution.inventory-projection','pms.inventory.projection_refresh_requested','property',$3)`,
        [events.outboxEventId, events.domainEventId, propertyId],
      );
      await seedChannelConnection();
      await admin.query("SAVEPOINT incomplete");
      await admin.query(
        "DELETE FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-06'",
        [propertyId, roomTypeB],
      );
      await expect(appendRoomClosureCalendar(admin, closureScope, events)).rejects.toThrow(
        "coverage is incomplete",
      );
      await admin.query("ROLLBACK TO SAVEPOINT incomplete");
      expect(await appendRoomClosureCalendar(admin, closureScope, events)).toEqual({
        calendarRevision: 2,
      });
      // Validate deferred calendar constraints before rollback, not merely the INSERTs.
      await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
      const afterDays = (
        await admin.query(
          "SELECT to_jsonb(day) AS value FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date",
          [propertyId],
        )
      ).rows;
      expect(afterDays).toEqual(
        beforeDays.map(({ value }) => ({
          value:
            value.room_type_id === roomTypeA
              ? value
              : {
                  ...value,
                  calendar_revision: 2,
                  generated_source_revision: 2,
                  inventory_revision: value.inventory_revision + 1,
                },
        })),
      );
      expect(
        (
          await admin.query(
            "SELECT * FROM pms.inventory_materialization_coverage WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0],
      ).toMatchObject({
        organization_id: beforeCoverage.organization_id,
        coverage_from: beforeCoverage.coverage_from,
        coverage_through: beforeCoverage.coverage_through,
        calendar_revision: 2,
        materialized_revision: 2,
        room_type_count: 1,
        expected_day_count: 3,
        materialized_day_count: 3,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.jobs WHERE property_id=$1 AND queue_name='pms.channex.management'",
            [propertyId],
          )
        ).rows[0].count,
      ).toBe(0);
      const successor = await admin.query(
        "SELECT room_type_id::text FROM pms.operating_calendar_room_bindings WHERE property_id=$1 AND calendar_revision=2",
        [propertyId],
      );
      expect(successor.rows).toEqual([{ room_type_id: roomTypeB }]);
    } finally {
      await admin.query("ROLLBACK");
    }
    expect((await preflight())?.roomUnitsRevision).toBe(5);
    await admin.query(
      `INSERT INTO pms.room_type_closures
      (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,
       expected_room_units_revision,previous_calendar_revision,closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
      VALUES ($1,$2,$3,$4,3,5,1,2,'2026-09-09',now(),$5)`,
      [propertyId, roomTypeA, randomUUID(), "a".repeat(64), actorUserId],
    );
    expect(await readModel.getCurrentOperatingCalendarConfiguration(propertyId)).toMatchObject({
      sourceStatus: "stale",
      sourceConflicts: [{ code: "room_type_set_conflict", currentRoomTypeIds: [roomTypeB] }],
    });
    expect(
      await repository.upsertOperatingCalendar(command("stale", { expectedCalendarRevision: 1 })),
    ).toMatchObject({
      ok: false,
      error: { code: "room_type_set_conflict", currentRoomTypeIds: [roomTypeB] },
    });
    expect(
      await impact.previewOperatingCalendarImpact(
        command("stale-preview", { expectedCalendarRevision: 1 }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "room_type_set_conflict", currentRoomTypeIds: [roomTypeB] },
    });
    const next = command("remaining", { expectedCalendarRevision: 1 });
    await seedChannelConnection();
    expect(
      await repository.upsertOperatingCalendar({
        ...next,
        roomTypeLimits: next.roomTypeLimits.filter((room) => room.roomTypeId === roomTypeB),
      }),
    ).toMatchObject({
      ok: true,
      response: {
        configuration: {
          calendarRevision: 2,
          sourceInputs: { roomBindings: [{ roomTypeId: roomTypeB }] },
        },
      },
    });
    expect(await readModel.getCurrentOperatingCalendarConfiguration(propertyId)).toMatchObject({
      sourceStatus: "current",
      sourceConflicts: [],
    });
    expect((await roomEvidence.getRoomTypeFacts(propertyId, roomTypeA))?.lifecycle).toBe("active");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.jobs WHERE property_id=$1 AND queue_name='pms.channex.management'",
          [propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  async function seedChannelConnection(): Promise<void> {
    const externalId = randomUUID();
    await admin.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
      VALUES ($1,'channex',$2,'active','enable')`,
      [propertyId, externalId],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id)
      VALUES ($1,'channex','connected',$2)`,
      [propertyId, externalId],
    );
  }
  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-1071 Command', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1071 Command', $2, 'active')`,
      [organizationId, organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, $2, 'VAY-1071 Command', 7)`,
      [propertyId, propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
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
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedRooms(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES
       (
         $1::uuid, $3::uuid, 'Garden Suite', '',
         '{"total":3,"adults":2,"children":1}'::jsonb,
         '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
         TRUE, 3, 5
       ),
       (
         $2::uuid, $3::uuid, 'Loft Suite', '',
         '{"total":4,"adults":3,"children":1}'::jsonb,
         '{"beds":[{"type":"king","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":40,"unit":"sqm"}}'::jsonb,
         TRUE, 4, 8
       )`,
      [roomTypeA, roomTypeB, propertyId],
    );
    const rooms = [
      [randomUUID(), roomTypeA, "A-101"],
      [randomUUID(), roomTypeA, "A-102"],
      [randomUUID(), roomTypeB, "B-201"],
      [randomUUID(), roomTypeB, "B-202"],
      [randomUUID(), roomTypeB, "B-203"],
    ] as const;
    for (const [roomId, roomTypeId, roomNumber] of rooms) {
      await admin.query(
        `INSERT INTO pms.rooms (
           id, property_id, room_type_id, room_number, status, operational_label_status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [roomId, propertyId, roomTypeId, roomNumber],
      );
    }
  }
});
function command(
  suffix: string,
  overrides: Partial<UpsertPmsOperatingCalendarCommand> = {},
): UpsertPmsOperatingCalendarCommand {
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
        startingSellableLimitCount: 2,
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
    idempotencyKey: `vay1071-command-${suffix}`,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `req-vay1071-command-${suffix}`,
      correlationId: `corr-vay1071-command-${suffix}`,
      requestedAt: acceptedAt,
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Invalid operating-calendar integration command");
  return parsed;
}
