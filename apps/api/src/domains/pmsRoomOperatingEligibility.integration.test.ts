import {
  createProductReadinessResult,
  createReadyProductReadinessEvidence,
} from "@vayada/domain-hotels";
import {
  createPgDistributionBookingPublicationProjection,
  BookingPublicationRoomClosureConflictError,
} from "./distributionBookingPublicationProjection.js";
import { createPmsMandatoryChargePricingSourceSnapshot } from "@vayada/domain-pms";
import { loadPmsMandatoryChargePricingSourceSnapshot } from "./pmsMandatoryChargePricingSourceSnapshot.js";
import { createPgPmsRecurringPricingReadModel } from "./pmsRecurringPricingReadModel.js";
import { createPgPropertySetupPmsOwnerRepository } from "./propertySetupPmsOwnerRepository.js";
import { createPgPmsPricingReadModel } from "./pmsPricingReadModel.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("room closure eligibility PostgreSQL", () => {
  const db = new pg.Client({ connectionString: url });
  let propertyId: string, roomTypeId: string, actorId: string;
  beforeAll(async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname))
      throw new Error("Test database required");
    await db.connect();
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    propertyId = randomUUID();
    roomTypeId = randomUUID();
    actorId = randomUUID();
    await db.query(
      "INSERT INTO identity.users (id,email,name,status) VALUES ($1,$2,'Closure test','active')",
      [actorId, `${actorId}@example.test`],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1::uuid,$1::text,'Closure test')",
      [propertyId],
    );
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Closure test',true)",
      [roomTypeId, propertyId],
    );
  });
  const close = (
    client: pg.Client,
    commandId = randomUUID(),
    property = propertyId,
    room = roomTypeId,
  ) =>
    client.query(
      `INSERT INTO pms.room_type_closures
      (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,
       expected_room_units_revision,previous_calendar_revision,closed_calendar_revision,
       cutoff_date,accepted_at,actor_user_id)
     VALUES ($1,$2,$3,$4,1,1,7,8,'2026-09-09','2026-09-09T01:00:00Z',$5)`,
      [property, room, commandId, "a".repeat(64), actorId],
    );

  it("keeps canonical facts active while excluding a closing room, retaining its receipt after retirement", async () => {
    expect(await readPmsRoomOperatingEligibility(db, propertyId)).toEqual([
      { propertyId, roomTypeId, state: "operating", closureCommandId: null, cutoffDate: null },
    ]);
    const commandId = randomUUID();
    await close(db, commandId);
    expect(await readPmsRoomOperatingEligibility(db, propertyId)).toEqual([
      {
        propertyId,
        roomTypeId,
        state: "closing",
        closureCommandId: commandId,
        cutoffDate: "2026-09-09",
      },
    ]);
    expect(
      (await db.query("SELECT active FROM pms.room_types WHERE id=$1", [roomTypeId])).rows,
    ).toEqual([{ active: true }]);
    await db.query("UPDATE pms.room_types SET active=false WHERE id=$1", [roomTypeId]);
    expect(await readPmsRoomOperatingEligibility(db, propertyId)).toEqual([
      {
        propertyId,
        roomTypeId,
        state: "inactive",
        closureCommandId: commandId,
        cutoffDate: "2026-09-09",
      },
    ]);
  });

  it("enforces property ownership in storage and never returns another property's rooms", async () => {
    const otherProperty = randomUUID();
    await db.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1::uuid,$1::text,'Other')",
      [otherProperty],
    );
    await expect(close(db, randomUUID(), otherProperty)).rejects.toMatchObject({ code: "23503" });
    expect(await readPmsRoomOperatingEligibility(db, otherProperty)).toEqual([]);
    expect((await readPmsRoomOperatingEligibility(db, propertyId))[0]?.state).toBe("operating");
  });

  it("rejects receipt rewrites and reusing a command for a different room", async () => {
    const commandId = randomUUID();
    await close(db, commandId);
    await expect(
      db.query("UPDATE pms.room_type_closures SET cutoff_date='2026-09-10' WHERE property_id=$1", [
        propertyId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("DELETE FROM pms.room_type_closures WHERE property_id=$1", [propertyId]),
    ).rejects.toMatchObject({ code: "23514" });
    const otherRoom = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Other',true)",
      [otherRoom, propertyId],
    );
    await expect(close(db, commandId, propertyId, otherRoom)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("shares the caller's transaction and rolls eligibility back with an aborted closure", async () => {
    await db.query("BEGIN");
    try {
      await close(db);
      expect((await readPmsRoomOperatingEligibility(db, propertyId))[0]?.state).toBe("closing");
    } finally {
      await db.query("ROLLBACK");
    }
    expect((await readPmsRoomOperatingEligibility(db, propertyId))[0]?.state).toBe("operating");
  });

  it("rejects invalid receipt evidence and preserves an unrelated operating room", async () => {
    const otherRoom = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Other',true)",
      [otherRoom, propertyId],
    );
    await close(db);
    expect(
      (await readPmsRoomOperatingEligibility(db, propertyId)).find(
        (row) => row.roomTypeId === otherRoom,
      ),
    ).toMatchObject({ state: "operating", closureCommandId: null });
    for (const [column, value] of [
      ["request_fingerprint", "invalid"],
      ["expected_room_facts_revision", "0"],
      ["expected_room_units_revision", "0"],
      ["previous_calendar_revision", "0"],
      ["closed_calendar_revision", "10"],
    ]) {
      // Column names and values are fixed test cases, never caller input.
      await expect(
        db.query(
          `INSERT INTO pms.room_type_closures
        SELECT property_id,$1::uuid,$2::uuid,
          ${column === "request_fingerprint" ? "'invalid'" : "request_fingerprint"},
          ${column === "expected_room_facts_revision" ? value : "expected_room_facts_revision"},
          ${column === "expected_room_units_revision" ? value : "expected_room_units_revision"},
          ${column === "previous_calendar_revision" ? value : "previous_calendar_revision"},
          ${column === "closed_calendar_revision" ? value : "closed_calendar_revision"},
          cutoff_date,accepted_at,actor_user_id
        FROM pms.room_type_closures WHERE property_id=$3`,
          [otherRoom, randomUUID(), propertyId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("fences inventory from the inclusive cutoff without changing historical or unrelated rooms", async () => {
    const otherRoom = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Other',true)",
      [otherRoom, propertyId],
    );
    await close(db);
    const day = (room: string, date: string, status: string, available: number) =>
      db.query(
        `INSERT INTO pms.inventory_days (property_id,room_type_id,stay_date,total_count,assigned_count,blocked_count,available_count,status)
       VALUES ($1,$2,$3,1,0,0,$4,$5)`,
        [propertyId, room, date, available, status],
      );
    await day(roomTypeId, "2026-09-08", "open", 1);
    await day(otherRoom, "2026-09-09", "open", 1);
    await expect(day(roomTypeId, "2026-09-09", "open", 1)).rejects.toMatchObject({ code: "23514" });
    await day(roomTypeId, "2026-09-09", "closed", 0);
    for (const change of [
      "status='open'",
      "available_count=1",
      "assigned_count=1",
      "blocked_count=1",
    ]) {
      await expect(
        db.query(
          `UPDATE pms.inventory_days SET ${change}
        WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-09-09'`,
          [propertyId, roomTypeId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(
      (
        await db.query(
          `SELECT room_type_id::text AS room,stay_date::text AS day,status,available_count
      FROM pms.inventory_days WHERE property_id=$1 ORDER BY stay_date,room_type_id`,
          [propertyId],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { room: roomTypeId, day: "2026-09-08", status: "open", available_count: 1 },
        { room: otherRoom, day: "2026-09-09", status: "open", available_count: 1 },
        { room: roomTypeId, day: "2026-09-09", status: "closed", available_count: 0 },
      ]),
    );
  });

  it("excludes closing-room pricing from publication sources but retains the canonical plan", async () => {
    const otherRoom = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Other',true)",
      [otherRoom, propertyId],
    );
    await db.query(
      "INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ($1,'EUR')",
      [propertyId],
    );
    for (const room of [roomTypeId, otherRoom])
      await db.query(
        `INSERT INTO pms.rate_plans
      (property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,pricing_contract_version,
       flexible_rate_plan_revision,source_room_facts_revision,source_pricing_currency_revision,cancellation_policy_snapshot)
      VALUES ($1,$2::uuid,$2::text,'Flexible','flexible',100,'EUR','pms-pricing.v1',1,1,1,
        '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}')`,
        [propertyId, room],
      );
    await db.query(
      `UPDATE pms.room_types SET room_facts_revision=1,
      description='Test room',category='suite',occupancy_limits='{"total":2,"adults":2,"children":0}',
      room_attributes='{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,"bathroomType":"private","size":{"value":30,"unit":"sqm"}}'
      WHERE property_id=$1`,
      [propertyId],
    );
    const organizationId = randomUUID();
    await db.query(
      `INSERT INTO identity.organizations (id,kind,name,slug,status)
      VALUES ($1::uuid,'hotel_group','Closure test',$1::text,'active')`,
      [organizationId],
    );
    await db.query(
      `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship,status)
      VALUES ($1,'pms','pms_property',$2,'owner','active')`,
      [organizationId, propertyId],
    );
    await db.query(
      `INSERT INTO identity.product_entitlements
      (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
      VALUES ($1,'pms','property-management','active','pms','pms_property',$2)`,
      [organizationId, propertyId],
    );
    const setup = createPgPropertySetupPmsOwnerRepository({ connectionString: url! });
    const recurring = createPgPmsRecurringPricingReadModel({ connectionString: url! });
    const pricing = createPgPmsPricingReadModel({ connectionString: url! });
    try {
      expect((await pricing.getPricingSourceSnapshot(propertyId))?.flexibleRatePlans).toHaveLength(
        2,
      );
      expect((await setup.getRoomOwnerSnapshot({ organizationId, propertyId })).rooms).toHaveLength(
        2,
      );
      const original = await pricing.getFlexibleRatePlan(propertyId, roomTypeId);
      await close(db);
      expect(
        (await pricing.getPricingSourceSnapshot(propertyId))?.flexibleRatePlans.map(
          (plan) => plan.roomTypeId,
        ),
      ).toEqual([otherRoom]);
      expect(await pricing.getFlexibleRatePlan(propertyId, roomTypeId)).toEqual(original);
      const roomSnapshot = await setup.getRoomOwnerSnapshot({ organizationId, propertyId });
      expect(roomSnapshot.rooms.map((room) => room.roomTypeId)).toEqual([otherRoom]);
      const publicationSource = createPmsMandatoryChargePricingSourceSnapshot({
        rooms: roomSnapshot.rooms.map((room) => ({
          roomTypeId: room.roomTypeId,
          roomFactsRevision: room.roomFactsRevision,
          occupancy: room.facts.occupancy,
        })),
        pricing: (await pricing.getPricingSourceSnapshot(propertyId))!,
        recurringPricing: (await recurring.getRecurringPricingBookingEvidence(propertyId))!,
      });
      const confirmationSource = await loadPmsMandatoryChargePricingSourceSnapshot(
        db,
        propertyId,
        new Date(),
      );
      expect(confirmationSource?.serializedPayload).toBe(publicationSource.serializedPayload);
      expect(
        (await db.query("SELECT active FROM pms.room_types WHERE id=$1", [roomTypeId])).rows,
      ).toEqual([{ active: true }]);
    } finally {
      await pricing.close();
      await recurring.close();
      await setup.close();
    }
  });

  it("fences activation of pre-closure content and preserves the remaining-room publication", async () => {
    await db.query("UPDATE hotel_catalog.properties SET lifecycle_status='active' WHERE id=$1", [
      propertyId,
    ]);
    const projection = createPgDistributionBookingPublicationProjection({ connectionString: url! });
    const otherRoom = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active) VALUES ($1,$2,'Other',true)",
      [otherRoom, propertyId],
    );
    const result = await createProductReadinessResult({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId,
      product: "booking",
      status: "ready",
      sourceManifest: {
        contractVersion: "onboarding-source-manifest.v1",
        propertyId,
        sources: [
          {
            ownerDomain: "pms",
            entityType: "room_type",
            entityId: roomTypeId,
            revision: "1",
          },
        ],
      },
      groups: [
        {
          groupId: "booking.rooms",
          status: "ready",
          steps: [
            {
              owningStepId: "rooms",
              status: "ready",
              entities: [
                {
                  source: {
                    ownerDomain: "pms",
                    entityType: "room_type",
                    entityId: roomTypeId,
                    revision: "1",
                  },
                  status: "ready",
                  blockers: [],
                },
              ],
            },
          ],
        },
      ],
      evaluatedAt: new Date().toISOString(),
    });
    const readiness = await createReadyProductReadinessEvidence(result, {
      propertyId,
      product: "booking",
    });
    const append = (rooms: { roomTypeId: string }[] | null) =>
      projection.appendRevision({
        propertyId,
        readiness,
        publicContent: { rooms },
        builtByUserId: actorId,
        builtAt: new Date().toISOString(),
      });
    try {
      const stale = await append([{ roomTypeId }, { roomTypeId: otherRoom }]);
      const previous = await projection.activate({
        propertyId,
        revisionId: stale.revisionId,
        expectedActiveRevisionId: null,
        activatedByUserId: actorId,
      });
      const malformed = await append(null);
      const current = await append([{ roomTypeId: otherRoom }]);
      await db.query("BEGIN");
      try {
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext('booking.publication'),hashtext($1::uuid::text))",
          [propertyId],
        );
        const pending = projection
          .activate({
            propertyId,
            revisionId: stale.revisionId,
            expectedActiveRevisionId: previous.revisionId,
            activatedByUserId: actorId,
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < deadline) {
          const waits = await db.query(
            `SELECT EXISTS(SELECT 1 FROM pg_locks
            WHERE locktype='advisory' AND classid=hashtext('booking.publication')::oid
              AND objid=hashtext($1::uuid::text)::oid AND NOT granted) AS blocked`,
            [propertyId],
          );
          if (waits.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await close(db);
        await db.query("COMMIT");
        expect(await pending).toBeInstanceOf(BookingPublicationRoomClosureConflictError);
        expect(await projection.getActive(propertyId)).toEqual(previous);
      } finally {
        await db.query("ROLLBACK");
      }
      const active = await projection.activate({
        propertyId,
        revisionId: current.revisionId,
        expectedActiveRevisionId: previous.revisionId,
        activatedByUserId: actorId,
      });
      for (const revision of [stale, malformed]) {
        await expect(
          projection.activate({
            propertyId,
            revisionId: revision.revisionId,
            expectedActiveRevisionId: active.revisionId,
            activatedByUserId: actorId,
          }),
        ).rejects.toBeInstanceOf(BookingPublicationRoomClosureConflictError);
        expect(await projection.getActive(propertyId)).toEqual(active);
      }
    } finally {
      await projection.close?.();
    }
  });

  it("serializes competing closure receipts to one winner", async () => {
    const competitor = new pg.Client({ connectionString: url });
    await competitor.connect();
    const winningCommand = randomUUID();
    try {
      await db.query("BEGIN");
      await close(db, winningCommand);
      const competitorPid = competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const loser = close(competitor).then(
        () => null,
        (error: unknown) => error,
      );
      const pid = (await competitorPid).rows[0]!.pid;
      const deadline = Date.now() + 3_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const waits = await db.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
          pid,
        ]);
        if (waits.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await db.query("COMMIT");
      expect(await loser).toMatchObject({ code: "23505" });
      expect((await readPmsRoomOperatingEligibility(db, propertyId))[0]?.closureCommandId).toBe(
        winningCommand,
      );
    } finally {
      await db.query("ROLLBACK");
      await competitor.end();
    }
  });
});
