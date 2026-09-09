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
    await impact.close();
    await readModel.close();
    await repository.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });
  it("rejects a pre-closure room set and accepts only remaining operating rooms", async () => {
    expect(await repository.upsertOperatingCalendar(command("before"))).toMatchObject({ ok: true });
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
  });
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
    schedule: { mode: "recurring", periods: [{ startsOn: "11-01", endsOn: "03-31" }] },
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
