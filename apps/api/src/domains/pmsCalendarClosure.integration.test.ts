import {
  createProductReadinessResult,
  createReadyProductReadinessEvidence,
} from "@vayada/domain-hotels";
import { createPgDistributionBookingPublicationProjection } from "./distributionBookingPublicationProjection.js";
import { createPgPmsRoomClosureRepository } from "./pmsRoomClosureCommandRepository.js";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./pmsPhysicalRoomUnitReconcileRepository.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { recordPmsRoomClosureEvents } from "./pmsRoomClosureEvents.js";
import { lockPmsManageScope } from "./pmsManageScope.js";
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { createPgPmsOperatingCalendarImpactService } from "./pmsOperatingCalendarImpact.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
let organizationId = randomUUID();
let propertyId = randomUUID();
let actorUserId = randomUUID();
let roomTypeA = randomUUID();
let roomTypeB = randomUUID();
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
  });
  beforeEach(async () => {
    organizationId = randomUUID();
    propertyId = randomUUID();
    actorUserId = randomUUID();
    roomTypeA = randomUUID();
    roomTypeB = randomUUID();
    await seedAuthorizedProperty();
    await seedRooms();
  });
  afterEach(async () => {
    // Retain audit/job history without leaving runnable synthetic delivery work.
    await admin.query(
      "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
      [propertyId],
    );
    await admin.query(
      "UPDATE platform.jobs SET status='canceled',finished_at=now() WHERE property_id=$1 AND queue_name='pms.channex.management' AND status='pending'",
      [propertyId],
    );
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
    await materialize();
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
      expect(
        await lockPmsManageScope(
          admin,
          { organizationId, propertyId, actorUserId },
          new Date(acceptedAt),
        ),
      ).toBe(true);
      expect(
        await lockPmsManageScope(
          admin,
          { organizationId: randomUUID(), propertyId, actorUserId },
          new Date(acceptedAt),
        ),
      ).toBe(false);

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
      await admin.query(
        `INSERT INTO platform.idempotency_keys
        (id,operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
        VALUES ($1,'pms','room_type.close',$2,$2,'property',$3,now()+interval '1 day')`,
        [closureScope.commandId, "d".repeat(64), propertyId],
      );
      const events = await recordPmsRoomClosureEvents(
        admin,
        { organizationId, propertyId, roomTypeId: roomTypeA, actorUserId },
        {
          idempotencyId: closureScope.commandId,
          keyHash: "d".repeat(64),
          requestId: "closure-test",
        },
        { calendarRevision: 2, cutoffDate: "2026-08-05", phase: "publication_refresh_required" },
        new Date("2026-08-05T10:00:00.000Z"),
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE domain_event_id=$1",
            [events.domainEventId],
          )
        ).rows[0].count,
      ).toBe(1);
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
  it("commits room closure once, rejects stale/unauthorized commands, and replays the recorded phase", async () => {
    expect(await repository.upsertOperatingCalendar(command("atomic"))).toMatchObject({ ok: true });
    await materialize();
    const closure = createPgPmsRoomClosureRepository({
      connectionString,
      now: () => new Date(acceptedAt),
      channex: {
        workerEnabled: false,
        bookingMutationOwner: "target",
        capabilityModes: {
          connection: "observe_only",
          provisioning: "observe_only",
          ariSync: "observe_only",
          bookingSync: "observe_only",
          markups: "observe_only",
          messaging: "observe_only",
          iframe: "observe_only",
        },
      },
    });
    const input = {
      organizationId,
      propertyId,
      roomTypeId: roomTypeA,
      actorUserId,
      expectedRoomFactsRevision: 3,
      expectedRoomUnitsRevision: 5,
      expectedCalendarRevision: 1,
      expectedActivePublicationRevisionId: null as string | null,
      idempotencyKey: randomUUID(),
      requestId: "atomic-test",
    };
    try {
      await admin.query("UPDATE pms.room_types SET active=false WHERE id=$1", [roomTypeA]);
      expect(await closure.preview(input)).toEqual({
        ok: false,
        error: { code: "room_type_not_found" },
      });
      expect(await closure.closeRoom(input)).toEqual({
        ok: false,
        error: { code: "room_type_not_found" },
      });
      await admin.query("UPDATE pms.room_types SET active=true WHERE id=$1", [roomTypeA]);
      expect(await closure.preview(input)).toMatchObject({ ok: true, impact: { blockers: [] } });
      expect(await closure.closeRoom({ ...input, organizationId: randomUUID() })).toMatchObject({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      expect(await closure.closeRoom({ ...input, expectedRoomFactsRevision: 2 })).toMatchObject({
        ok: false,
        error: { code: "room_closure_revision_conflict" },
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.idempotency_keys WHERE property_id=$1 AND operation='room_type.close'",
            [propertyId],
          )
        ).rows[0].count,
      ).toBe(0);
      await admin.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
        VALUES ($1::uuid,$1::text,'Closure test',$1::text,'en',ARRAY['en'],'complete')`,
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
      const inventory = createTargetPmsInventoryReservationPort();
      const reserve = (transaction: pg.Client | pg.PoolClient, roomTypeId = roomTypeA) =>
        inventory.reserve({
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
      let hold: Awaited<ReturnType<typeof reserve>> | undefined;
      let blockedClosure: ReturnType<typeof closure.closeRoom> | undefined;
      try {
        await admin.query("BEGIN");
        hold = await reserve(admin);
        expect(hold).not.toBeNull();
        blockedClosure = closure.closeRoom(input);
        void blockedClosure.catch(() => {});
        await waitingOn(null);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        await Promise.allSettled([blockedClosure]);
        throw error;
      }
      expect(await blockedClosure).toMatchObject({
        ok: false,
        error: {
          code: "room_closure_protected",
          blockers: expect.arrayContaining(["active_reservations"]),
        },
      });
      await admin.query("BEGIN");
      try {
        await inventory.release({
          transaction: admin,
          propertyId,
          reservation: hold!,
          occurredAt: new Date(acceptedAt),
        });
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const snapshot = async () =>
        (
          await admin.query(
            `SELECT jsonb_build_object(
        'rooms',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pms.room_types t WHERE property_id=$1),
        'units',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pms.rooms t WHERE property_id=$1),
        'days',(SELECT jsonb_agg(to_jsonb(t) ORDER BY room_type_id,stay_date) FROM pms.inventory_days t WHERE property_id=$1),
        'calendar',(SELECT jsonb_agg(to_jsonb(t) ORDER BY calendar_revision) FROM pms.operating_calendar_revisions t WHERE property_id=$1),
        'coverage',(SELECT to_jsonb(t) FROM pms.inventory_materialization_coverage t WHERE property_id=$1),
        'bindings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY calendar_revision,room_type_id) FROM pms.operating_calendar_room_bindings t WHERE property_id=$1),
        'periods',(SELECT jsonb_agg(to_jsonb(t) ORDER BY calendar_revision,period_index) FROM pms.operating_calendar_recurring_periods t WHERE property_id=$1),
        'offers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY room_type_id,stay_date) FROM distribution.public_room_offer_snapshots t WHERE property_id=$1),
        'receipts',(SELECT count(*) FROM pms.room_type_closures WHERE property_id=$1),
        'events',(SELECT count(*) FROM platform.domain_events WHERE property_id=$1),
        'outbox',(SELECT count(*) FROM platform.outbox_events WHERE property_id=$1),
        'audit',(SELECT count(*) FROM platform.product_audit_events WHERE property_id=$1),
        'keys',(SELECT count(*) FROM platform.idempotency_keys WHERE property_id=$1)
      ) AS value`,
            [propertyId],
          )
        ).rows[0].value;
      await admin.query(
        "UPDATE hotel_catalog.properties SET lifecycle_status='active' WHERE id=$1",
        [propertyId],
      );
      // Queue real publication activation ahead of closure on the same fence.
      const publication = createPgDistributionBookingPublicationProjection({ connectionString });
      const source = {
        ownerDomain: "pms" as const,
        entityType: "room_type",
        entityId: roomTypeA,
        revision: "3",
      };
      const ready = await createProductReadinessResult({
        contractVersion: "onboarding-product-readiness.v1",
        propertyId,
        product: "booking",
        status: "ready",
        sourceManifest: {
          contractVersion: "onboarding-source-manifest.v1",
          propertyId,
          sources: [source],
        },
        groups: [
          {
            groupId: "booking.rooms",
            status: "ready",
            steps: [
              {
                owningStepId: "rooms",
                status: "ready",
                entities: [{ source, status: "ready", blockers: [] }],
              },
            ],
          },
        ],
        evaluatedAt: acceptedAt,
      });
      const revision = await publication.appendRevision({
        propertyId,
        readiness: await createReadyProductReadinessEvidence(ready, {
          propertyId,
          product: "booking",
        }),
        publicContent: { rooms: [{ roomTypeId: roomTypeA }, { roomTypeId: roomTypeB }] },
        builtByUserId: actorUserId,
        builtAt: acceptedAt,
      });
      let activating: ReturnType<typeof publication.activate> | undefined;
      let staleClosure: ReturnType<typeof closure.closeRoom> | undefined;
      try {
        await admin.query("BEGIN");
        await admin.query(
          "SELECT pg_advisory_xact_lock(hashtext('booking.publication'),hashtext($1::uuid::text))",
          [propertyId],
        );
        activating = publication.activate({
          propertyId,
          revisionId: revision.revisionId,
          expectedActiveRevisionId: null,
          activatedByUserId: actorUserId,
        });
        void activating.catch(() => {});
        const beforePublicationRace = await snapshot();
        const activationPid = await waitingOn(null);
        staleClosure = closure.closeRoom(input);
        void staleClosure.catch(() => {});
        await waitingOn(null, null, activationPid);
        await admin.query("COMMIT");
        expect(await activating).toMatchObject({ revisionId: revision.revisionId });
        expect(await staleClosure).toMatchObject({
          ok: false,
          error: { code: "room_closure_revision_conflict" },
        });
        expect(await snapshot()).toEqual(beforePublicationRace);
        input.expectedActivePublicationRevisionId = revision.revisionId;
      } finally {
        await admin.query("ROLLBACK");
        await Promise.allSettled([activating, staleClosure]);
        await publication.close?.();
      }
      const before = await snapshot();
      await admin.query(`CREATE FUNCTION pg_temp.reject_closure_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.property_id='${propertyId}'::uuid AND NEW.calendar_revision=2 THEN
          RAISE EXCEPTION 'injected late closure failure'; END IF; RETURN NEW; END $$`);
      await admin.query(
        "CREATE TRIGGER closure_test_failure BEFORE UPDATE ON pms.inventory_materialization_coverage FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_closure_test()",
      );
      try {
        await expect(closure.closeRoom(input)).rejects.toThrow("injected late closure failure");
        expect(await snapshot()).toEqual(before);
      } finally {
        await admin.query(
          "DROP TRIGGER closure_test_failure ON pms.inventory_materialization_coverage",
        );
      }
      // Hold publication so closure owns units before reconciliation authorizes
      // with a property SHARE lock. Closure must not upgrade that property lock.
      const reconciliation = createPgPmsPhysicalRoomUnitReconcileRepository({
        connectionString,
        now: () => new Date(acceptedAt),
      });
      const capturedCalendar = (await readModel.getCurrentOperatingCalendarConfiguration(
        propertyId,
      ))!.configuration!;
      const materializer = createPgPmsInventoryMaterializationRepository({
        connectionString,
        authorization: { authorizeInventoryMaterialization: async () => true },
        operatingCalendar: readModel,
        propertyProfileEvidence: profileEvidence,
        roomCapacity: roomEvidence,
        now: () => new Date(acceptedAt),
      });
      let materializing: ReturnType<typeof materializer.materializeInventory> | undefined;
      let materialized: Awaited<NonNullable<typeof materializing>> | undefined;
      let closing: ReturnType<typeof closure.closeRoom> | undefined;
      let reconciling: ReturnType<typeof reconciliation.reconcilePhysicalRoomUnits> | undefined;
      const lateBookingClient = new pg.Client({ connectionString });
      let lateBooking: ReturnType<typeof reserve> | undefined;
      let result: Awaited<typeof closing> | undefined;
      let reconciled: Awaited<NonNullable<typeof reconciling>> | undefined;
      let lateReceipt: Awaited<ReturnType<typeof reserve>> | undefined;
      try {
        await admin.query("BEGIN");
        await admin.query(
          "SELECT pg_advisory_xact_lock(hashtext('booking.publication'),hashtext($1::uuid::text))",
          [propertyId],
        );
        closing = closure.closeRoom(input);
        void closing.catch(() => {});
        await lateBookingClient.connect();
        await lateBookingClient.query("BEGIN");
        const lateBookingPid = (await lateBookingClient.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        try {
          const closurePid = await waitingOn(null);
          materializing = materializer.materializeInventory({
            organizationId,
            propertyId,
            configurationSource: capturedCalendar.source,
            expectedMaterializedRevision: 1,
            horizon: { from: "2026-08-04", through: "2026-08-06" },
            idempotencyKey: randomUUID(),
            audit: command("waiting-materializer").audit,
          });
          void materializing.catch(() => {});
          const materializerPid = await waitingOn(closurePid);

          reconciling = reconciliation.reconcilePhysicalRoomUnits({
            organizationId,
            propertyId,
            roomTypeId: roomTypeA,
            expectedRevision: 5,
            targetActiveUnitCount: 2,
            idempotencyKey: randomUUID(),
            audit: command("concurrent").audit,
          });
          void reconciling.catch(() => {});
          await waitingOn(closurePid, null, materializerPid);
          lateBooking = reserve(lateBookingClient);
          void lateBooking.catch(() => {});
          await waitingOn(closurePid, lateBookingPid);
        } finally {
          await admin.query("COMMIT");
        }
        [result, reconciled, lateReceipt, materialized] = await Promise.all([
          closing,
          reconciling,
          lateBooking,
          materializing,
        ]);
      } finally {
        await admin.query("ROLLBACK");
        await Promise.allSettled([closing, reconciling, lateBooking, materializing]);
        await lateBookingClient.query("ROLLBACK").catch(() => {});
        await Promise.all([lateBookingClient.end(), reconciliation.close(), materializer.close()]);
      }
      expect(materialized).toMatchObject({
        ok: false,
        error: { code: "configuration_not_current" },
      });
      const afterRaces = await snapshot();
      expect(afterRaces.coverage).toMatchObject({
        calendar_revision: 2,
        materialized_revision: 2,
        room_type_count: 1,
        expected_day_count: 3,
        materialized_day_count: 3,
        coverage_from: before.coverage.coverage_from,
        coverage_through: before.coverage.coverage_through,
      });
      expect(afterRaces.days).toEqual(
        before.days.map((day: Record<string, unknown>) => ({
          ...day,
          inventory_revision: Number(day.inventory_revision) + 1,
          ...(day.room_type_id === roomTypeA
            ? { status: "closed", available_count: 0, closure_source_revision: 1 }
            : { calendar_revision: 2, generated_source_revision: 2 }),
        })),
      );
      expect(lateReceipt).toBeNull();
      expect(reconciled).toMatchObject({
        ok: false,
        error: { code: "room_units_revision_conflict" },
      });
      await admin.query("BEGIN");
      try {
        expect(await reserve(admin)).toBeNull();
        expect(await reserve(admin, roomTypeB)).not.toBeNull();
      } finally {
        await admin.query("ROLLBACK");
      }
      expect(result).toMatchObject({
        ok: true,
        roomTypeId: roomTypeA,
        calendarRevision: 2,
        roomUnitsRevision: 6,
        cutoffDate: "2026-08-04",
        phase: "publication_refresh_required",
        closedInventoryDays: 3,
      });
      expect(await closure.closeRoom(input)).toEqual(result);
      await admin.query(
        "UPDATE platform.idempotency_keys SET idempotency_metadata='null'::jsonb WHERE property_id=$1 AND operation='room_type.close' AND status='completed'",
        [propertyId],
      );
      await expect(closure.closeRoom(input)).rejects.toThrow(
        "Invalid persisted room closure result",
      );

      expect(await closure.closeRoom({ ...input, roomTypeId: roomTypeB })).toMatchObject({
        ok: false,
        error: { code: "idempotency_key_conflict" },
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pms.room_type_closures WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.domain_events WHERE property_id=$1 AND event_type='pms.room_type.closed'",
            [propertyId],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT room_type_id::text FROM pms.operating_calendar_room_bindings WHERE property_id=$1 AND calendar_revision=2",
            [propertyId],
          )
        ).rows,
      ).toEqual([{ room_type_id: roomTypeB }]);
      expect(
        (
          await admin.query(
            "SELECT status FROM pms.rooms WHERE property_id=$1 AND room_type_id=$2",
            [propertyId, roomTypeA],
          )
        ).rows.every((unit) => unit.status === "retired"),
      ).toBe(true);
    } finally {
      await closure.dispose();
    }
    async function waitingOn(
      holderPid: number | null,
      waiterPid: number | null = null,
      excludedPid: number | null = null,
    ): Promise<number> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await admin.query(
          `SELECT waiter.pid FROM pg_locks waiter JOIN pg_locks holder
          USING(locktype,database,classid,objid,objsubid)
          WHERE holder.pid=COALESCE($1::int,pg_backend_pid()) AND holder.granted AND NOT waiter.granted
            AND holder.locktype='advisory' AND ($2::int IS NULL OR waiter.pid=$2::int) AND ($3::int IS NULL OR waiter.pid<>$3::int)`,
          [holderPid, waiterPid, excludedPid],
        );
        if (waiting.rows[0]) return waiting.rows[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Expected concurrent advisory lock waiter");
    }
  });
  async function materialize(): Promise<void> {
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
  }
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
