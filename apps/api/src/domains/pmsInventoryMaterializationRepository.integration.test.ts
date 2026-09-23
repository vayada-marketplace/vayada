import {
  CHANNEX_MANAGEMENT_WORKER_ROLE,
  channexManagementWorkerPrivileges,
} from "../jobs/channexManagementWorkerPrivileges.js";
import { appendExternalNightlyRevenueEconomics } from "./financeOtaCommissionEvidence.js";
import { captureChannexAlterationFinance } from "./channexAlterationFinance.js";
import { hasBookingFinancialEvidence } from "./financeBookingAlterationGuard.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import {
  claimChannexRoomAvailability,
  prepareChannexRoomAvailabilityEvidence,
  reconcileCurrentChannexRoomAvailability,
} from "./channexRoomAvailabilityEvidence.js";
import {
  prepareChannexRoomAvailabilityReceiptPersistence,
  prepareChannexRoomAvailabilityTransportFailurePersistence,
} from "./channexRoomAvailabilityReceiptStore.js";
import { prepareChannexRoomAvailabilityDispatch } from "./channexRoomAvailabilityDispatch.js";
import { prepareNextChannexRoomAvailabilityDispatch } from "./channexRoomAvailabilityCoordinator.js";
import { reconcilePendingChannexRoomAvailability } from "./channexPendingRoomAvailabilityReconciliation.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";
import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { createHash, randomUUID } from "node:crypto";
import { runChannexBookingJobs } from "../jobs/channexBookings.js";
import { persistChannexAssignments } from "./channexBookingAssignments.js";
import { applyChannexAlterationRevision } from "./channexAlterationRevision.js";

import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  type PmsInventoryMaterializationCommand,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarReadPort,
  type RoomCapacityReadPort,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPgPmsInventoryMaterializationRepository,
  type PmsInventoryMaterializationAuthorizationPort,
  type PmsInventoryMaterializationRepository,
} from "./pmsInventoryMaterializationRepository.js";

import { assertChannexAlterationAvailability } from "./channexAlterationAvailability.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ACCEPTED_AT = new Date("2026-08-04T09:00:00.000Z");

type Fixture = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  actorUserId: string;
  configurations: ReadonlyMap<number, PmsOperatingCalendarConfigurationSnapshot>;
  calendarState: {
    currentRevision: number;
    stale: boolean;
    readCount: number;
    staleOnRead: number | null;
  };
  capacityState: { revision: number; count: number };
  profileState: { available: boolean; revision: number };
  authorizationState: { allowed: boolean };
  authorize: ReturnType<typeof vi.fn>;
  repository: PmsInventoryMaterializationRepository;
  workerRepository: (connectionString: string) => PmsInventoryMaterializationRepository;
}>;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS inventory materialization repository", () => {
  const adminPool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let admin: pg.PoolClient;
  const repositories: PmsInventoryMaterializationRepository[] = [];
  const alterationBookings: string[] = [];
  const channelPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    admin = await adminPool.connect();
  });

  afterAll(async () => {
    await Promise.all(repositories.map((repository) => repository.close()));
    await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
    for (const table of ["product_audit_events", "dead_letter_events", "job_attempts"]) {
      await admin.query(
        `DELETE FROM platform.${table} WHERE job_id IN (SELECT id FROM platform.jobs WHERE payload->>'propertyId' IN (SELECT property_id::text FROM booking.guest_bookings WHERE id=ANY($1::uuid[])))`,
        [alterationBookings],
      );
    }
    await admin.query(
      "DELETE FROM platform.jobs WHERE payload->>'propertyId' IN (SELECT property_id::text FROM booking.guest_bookings WHERE id=ANY($1::uuid[]))",
      [alterationBookings],
    );
    await admin.query(
      "DELETE FROM booking.booking_change_requests WHERE guest_booking_id = ANY($1::uuid[])",
      [alterationBookings],
    );
    await admin.query(
      "DELETE FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=ANY($1::uuid[])",
      [alterationBookings],
    );
    await admin.query("COMMIT");
    admin.release();
    await adminPool.end();
    await channelPool.end();
  });

  it("checks Airbnb alterations against real materialization and canonical assignments", async () => {
    const additionalType = randomUUID(),
      additionalExternal = randomUUID();
    const fixture = await createFixture(admin, repositories, [2], [additionalType]);
    const { propertyId, roomTypeId } = fixture;
    const connectionId = randomUUID(),
      externalRoom = randomUUID(),
      bookingId = randomUUID();
    alterationBookings.push(bookingId);
    await admin.query(
      `INSERT INTO pms.rooms(property_id,room_type_id,room_number)
      VALUES($1,$2,'A'),($1,$2,'B'),($1,$3,'C'),($1,$3,'D')`,
      [propertyId, roomTypeId, additionalType],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status)
      VALUES($1,$2,'channex','connected')`,
      [connectionId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
      VALUES($1,$2,$3,$4),($1,$2,$5,$6)`,
      [propertyId, connectionId, roomTypeId, externalRoom, additionalType, additionalExternal],
    );
    expect(
      await fixture.repository.materializeInventory(
        materializationCommand(fixture, "airbnb-materialized", 1, "2026-08-04", "2026-08-06"),
      ),
    ).toMatchObject({ ok: true, outcome: "applied" });
    await admin.query(
      `UPDATE pms.inventory_days SET rate_gate_open=TRUE, inventory_revision=inventory_revision+1, generated_pricing_source_fingerprint=repeat('a',64) WHERE property_id=$1`,
      [propertyId],
    );
    async function book(id: string, from: string, to: string) {
      await admin.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,room_count,currency)
        VALUES($1::uuid,$2,$1::text,'airbnb','confirmed',$3,$4,2,'EUR')`,
        [id, propertyId, from, to],
      );
      await admin.query(
        `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,position,source,check_in,check_out,stay_evidence_kind,adults,children,room_id)
        VALUES($1,$2,$3,1,'channel',$4,$5,'exact',1,0,(SELECT id FROM pms.rooms WHERE property_id=$1 AND room_number='A')),($1,$2,$3,2,'channel',$4,$5,'exact',1,0,(SELECT id FROM pms.rooms WHERE property_id=$1 AND room_number='B'))`,
        [propertyId, id, roomTypeId, from, to],
      );
      await admin.query("BEGIN");
      try {
        await reconcilePmsOccupiedInventory(
          admin,
          propertyId,
          [{ roomTypeId, checkIn: from, checkOut: to }],
          ACCEPTED_AT.toISOString(),
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    await book(bookingId, "2026-08-04", "2026-08-06");
    const input = {
      propertyId,
      bookingId,
      changes: {
        requestedCheckIn: "2026-08-04",
        requestedCheckOut: "2026-08-06",
        rooms: [{ roomTypeId: externalRoom }, { roomTypeId: externalRoom }],
        channex: { connectionId },
      },
    };
    async function check() {
      await admin.query("BEGIN");
      try {
        const beforeCheck = await admin.query(
          `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
          [propertyId],
        );
        let availabilityError: unknown;
        try {
          await assertChannexAlterationAvailability(admin, input);
        } catch (error) {
          availabilityError = error;
        }
        expect(
          (
            await admin.query(
              `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
              [propertyId],
            )
          ).rows,
        ).toEqual(beforeCheck.rows);
        if (availabilityError) throw availabilityError;
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    const before = await admin.query(
      `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
      [propertyId],
    );
    await expect(check()).resolves.toBeUndefined();
    expect(
      (
        await admin.query(
          `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
          [propertyId],
        )
      ).rows,
    ).toEqual(before.rows);
    input.changes.requestedCheckOut = "2026-08-07";
    await expect(check()).resolves.toBeUndefined();
    async function prepareRevision(checkout: string) {
      const externalProperty = randomUUID(),
        providerBookingId = randomUUID();
      const requestId = randomUUID(),
        revisionId = randomUUID();
      await admin.query(
        `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')`,
        [propertyId, externalProperty],
      );
      const bindingGeneration = (
        await admin.query(
          `UPDATE pms.channel_connections SET external_property_id=$2 WHERE id=$1 RETURNING binding_generation`,
          [connectionId, externalProperty],
        )
      ).rows[0].binding_generation as string;
      const original = (
        await admin.query(
          `SELECT check_in::text,check_out::text,total_amount::text,adults,children FROM booking.guest_bookings WHERE id=$1`,
          [bookingId],
        )
      ).rows[0];
      const changes = {
        ...input.changes,
        requestedCheckOut: checkout,
        providerBookingId,
        oldCheckIn: original.check_in,
        oldCheckOut: original.check_out,
        oldTotal: original.total_amount,
        oldAdults: original.adults,
        oldChildren: original.children,
        requestedAdults: 2,
        requestedChildren: 0,
        currency: "EUR",
        newTotal: "25.00",
        rooms: [
          { roomTypeId: externalRoom, adults: 1, children: 0 },
          { roomTypeId: externalRoom, adults: 1, children: 0 },
        ],
        channex: {
          eventId: randomUUID(),
          connectionId,
          bindingGeneration,
          providerPropertyId: externalProperty,
          providerState: "accepted",
        },
      };
      await admin.query(
        `INSERT INTO booking.booking_change_requests(id,guest_booking_id,request_type,requested_by,requested_changes)
        VALUES($1,$2,'date_change','guest',$3)`,
        [requestId, bookingId, changes],
      );
      const scope = {
        propertyId,
        bookingId,
        connectionId,
        bindingGeneration,
        providerPropertyId: externalProperty,
      };
      const revision = {
        id: revisionId,
        attributes: {
          booking_id: providerBookingId,
          property_id: externalProperty,
          status: "modified",
          arrival_date: "2026-08-04",
          departure_date: checkout,
          currency: "EUR",
          amount: "25.00",
          rooms: [
            { room_type_id: externalRoom, occupancy: { adults: 1, children: 0 } },
            { room_type_id: externalRoom, occupancy: { adults: 1, children: 0 } },
          ],
        },
      };
      return { scope, revision, requestId, revisionId, providerBookingId };
    }
    // Count/type changes use real materialization and preserve slot history.
    await admin.query("BEGIN");
    try {
      const change = await prepareRevision("2026-08-06");
      const ratePlan = randomUUID();
      await admin.query(
        "INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,currency) VALUES($1,$2,$3,'AIRBNB','Airbnb','EUR')",
        [ratePlan, propertyId, roomTypeId],
      );
      await admin.query(
        "UPDATE pms.operational_booking_assignments SET rate_plan_id=$2,assignment_status='assigned',assigned_at=now() WHERE guest_booking_id=$1",
        [bookingId, ratePlan],
      );
      const originalSlots = (
        await admin.query(
          "SELECT id,room_id FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
          [bookingId],
        )
      ).rows;
      async function changeRooms(externalTypes: ReturnType<typeof randomUUID>[]) {
        const original = (
          await admin.query(
            "SELECT check_in::text,check_out::text,total_amount::text,adults,children FROM booking.guest_bookings WHERE id=$1",
            [bookingId],
          )
        ).rows[0];
        change.revision.id = randomUUID();
        change.revision.attributes.rooms = externalTypes.map((room_type_id) => ({
          room_type_id,
          occupancy: { adults: 1, children: 0 },
        }));
        await admin.query(
          `UPDATE booking.booking_change_requests SET status='pending',requested_changes=requested_changes || $2::jsonb WHERE id=$1`,
          [
            change.requestId,
            JSON.stringify({
              oldCheckIn: original.check_in,
              oldCheckOut: original.check_out,
              oldTotal: original.total_amount,
              oldAdults: original.adults,
              oldChildren: original.children,
              rooms: externalTypes.map((roomTypeId) => ({ roomTypeId, adults: 1, children: 0 })),
            }),
          ],
        );
        return applyChannexAlterationRevision(admin, change.scope, change.revision);
      }
      await expect(changeRooms([externalRoom])).resolves.toBe(true);
      let slots = (
        await admin.query(
          "SELECT id,room_id,assignment_status,assignment_payload FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
          [bookingId],
        )
      ).rows;
      expect(slots[0].room_id).toBe(originalSlots[0].room_id);
      expect(slots[1]).toMatchObject({
        id: originalSlots[1].id,
        assignment_status: "released",
        assignment_payload: { channexAlterationReleased: true },
      });
      await expect(changeRooms([externalRoom, externalRoom])).resolves.toBe(true);
      slots = (
        await admin.query(
          "SELECT id,room_id,assignment_status,assignment_payload FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
          [bookingId],
        )
      ).rows;
      expect(slots[1]).toMatchObject({
        id: originalSlots[1].id,
        room_id: null,
        assignment_status: "pending",
        assignment_payload: { version: "reservation-v2" },
      });
      expect(slots[1].assignment_payload.channexAlterationReleased).toBeUndefined();
      // A third room of the same type exceeds capacity, even with own-booking credit.
      await expect(changeRooms([externalRoom, externalRoom, externalRoom])).rejects.toThrow(
        "alteration_rooms_unavailable",
      );
      await expect(changeRooms([externalRoom, externalRoom, additionalExternal])).resolves.toBe(
        true,
      );
      expect(
        (
          await admin.query(
            "SELECT DISTINCT assignment_payload->>'version' AS version FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 AND assignment_status<>'released'",
            [bookingId],
          )
        ).rows,
      ).toEqual([{ version: "reservation-v3" }]);
      expect(
        (
          await admin.query("SELECT room_count FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows[0].room_count,
      ).toBe(3);
      await expect(changeRooms([additionalExternal, externalRoom])).resolves.toBe(true);
      slots = (
        await admin.query(
          "SELECT id,room_id,room_type_id,rate_plan_id,assigned_at,assignment_status FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
          [bookingId],
        )
      ).rows;
      expect(slots[0]).toMatchObject({
        id: originalSlots[0].id,
        room_id: null,
        room_type_id: additionalType,
        rate_plan_id: null,
        assigned_at: null,
        assignment_status: "pending",
      });
      expect(slots[2].assignment_status).toBe("released");
      expect(
        (
          await admin.query(
            "SELECT room_type_id,assigned_count FROM pms.inventory_days WHERE property_id=$1 AND stay_date='2026-08-04' ORDER BY room_type_id",
            [propertyId],
          )
        ).rows,
      ).toEqual(
        [roomTypeId, additionalType]
          .sort()
          .map((room_type_id) => ({ room_type_id, assigned_count: 1 })),
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1 AND outbox_key LIKE $2",
            [propertyId, `channex.alteration.applied:${change.requestId}:${change.revision.id}:%`],
          )
        ).rows[0].count,
      ).toBe(6);
      await expect(
        applyChannexAlterationRevision(admin, change.scope, change.revision),
      ).resolves.toBe(false);
      await expect(changeRooms([additionalExternal])).resolves.toBe(true);
      expect(
        (
          await admin.query(
            "SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-04'",
            [propertyId, roomTypeId],
          )
        ).rows[0].assigned_count,
      ).toBe(0);
      // Run the actual booking-wide command in a nested transaction, then restore the fixture.
      await admin.query("SAVEPOINT before_no_show");
      const commands = createTargetPmsOperationsCommandRepository({
        connectionString: TEST_DATABASE_URL!,
        readRepository: createTargetPmsOperationsReadRepository({
          connectionString: TEST_DATABASE_URL!,
          pool: admin,
        }),
        pool: {
          end: async () => {},
          connect: async () => ({
            release() {},
            query: <T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) =>
              admin.query<T>(
                text === "BEGIN"
                  ? "SAVEPOINT operational_command"
                  : text === "COMMIT"
                    ? "RELEASE SAVEPOINT operational_command"
                    : text === "ROLLBACK"
                      ? "ROLLBACK TO SAVEPOINT operational_command"
                      : text,
                values ? [...values] : undefined,
              ),
          }),
        },
      });
      const commandId = randomUUID();
      expect(
        await commands.executeNoShowCommand({
          propertyId,
          guestBookingId: bookingId,
          commandId,
          idempotencyKey: commandId,
          expectedVersion: "reservation-v5",
          audit: {
            actor: {
              kind: "user",
              userId: fixture.actorUserId,
              organizationId: fixture.organizationId,
            },
            requestId: commandId,
            reason: "Synthetic alteration regression",
            requestedAt: ACCEPTED_AT.toISOString(),
          },
        }),
      ).toMatchObject({ ok: true });
      expect(
        (
          await admin.query(
            "SELECT position,assignment_payload->>'operationalStatus' AS status FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
            [bookingId],
          )
        ).rows,
      ).toEqual([
        { position: 1, status: "no_show" },
        { position: 2, status: null },
        { position: 3, status: null },
      ]);
      await admin.query("ROLLBACK TO SAVEPOINT before_no_show");
      // Unrelated canceled slots cannot be revived by a count increase.
      await admin.query(
        "UPDATE pms.operational_booking_assignments SET assignment_status='canceled' WHERE guest_booking_id=$1 AND position=3",
        [bookingId],
      );
      await expect(
        changeRooms([additionalExternal, externalRoom, additionalExternal]),
      ).rejects.toThrow("alteration_revision_assignment_unsupported");
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("BEGIN");
    try {
      const change = await prepareRevision("2026-08-07");
      await admin.query(
        `UPDATE booking.booking_change_requests SET requested_changes=requested_changes || '{"newTotal":null,"priceDifference":null}'::jsonb WHERE id=$1`,
        [change.requestId],
      );
      for (const amount of [undefined, null, "", "-1.00", "NaN", "10000000000000.00", "25.001"]) {
        await expect(
          applyChannexAlterationRevision(admin, change.scope, {
            ...change.revision,
            attributes: { ...change.revision.attributes, amount },
          }),
        ).rejects.toThrow();
      }
      await expect(
        applyChannexAlterationRevision(admin, change.scope, {
          ...change.revision,
          attributes: { ...change.revision.attributes, currency: "USD" },
        }),
      ).rejects.toThrow("alteration_revision_proposal_mismatch");
      expect(
        (
          await admin.query(
            "SELECT check_out::text,total_amount::text FROM booking.guest_bookings WHERE id=$1",
            [bookingId],
          )
        ).rows[0],
      ).toEqual({ check_out: "2026-08-06", total_amount: "0.00" });
      await admin.query(
        "UPDATE booking.booking_change_requests SET requested_changes=requested_changes - 'newTotal' WHERE id=$1",
        [change.requestId],
      );
      await expect(
        applyChannexAlterationRevision(admin, change.scope, change.revision),
      ).rejects.toThrow();
      await admin.query(
        `UPDATE booking.booking_change_requests SET requested_changes=requested_changes || '{"newTotal":null}'::jsonb WHERE id=$1`,
        [change.requestId],
      );
      // An explicit provider zero is valid; a missing amount above is not zero.
      change.revision.attributes.amount = "0.00";
      await expect(
        applyChannexAlterationRevision(admin, change.scope, change.revision),
      ).resolves.toBe(true);
      expect(
        (
          await admin.query(
            "SELECT status,requested_changes->'newTotal' AS quote,requested_changes->'priceDifference' AS difference FROM booking.booking_change_requests WHERE id=$1",
            [change.requestId],
          )
        ).rows[0],
      ).toEqual({ status: "accepted", quote: null, difference: null });
    } finally {
      await admin.query("ROLLBACK");
    }
    for (const evidence of ["revenue", "payment", "folio"]) {
      await admin.query("BEGIN");
      try {
        await admin.query(
          "UPDATE booking.guest_bookings SET total_amount=25,balance_amount=15 WHERE id=$1",
          [bookingId],
        );
        const change = await prepareRevision("2026-08-07");
        if (evidence === "revenue") {
          await admin.query(
            "INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id) VALUES($1,$2)",
            [propertyId, roomTypeId],
          );
          await admin.query(
            `INSERT INTO booking.nightly_revenue_evidence(property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,command_key)
            VALUES($1,$2,$3,'2026-08-04','2026-08-04','EUR',25,1,'room_night','confirmed','ota','exact',1,$4)`,
            [propertyId, bookingId, roomTypeId, randomUUID()],
          );
        } else if (evidence === "payment") {
          await admin.query(
            "INSERT INTO finance.payments(property_id,guest_booking_id,payment_kind,status,amount,currency) VALUES($1,$2,'deposit','paid',10,'EUR')",
            [propertyId, bookingId],
          );
        } else {
          await admin.query(
            "INSERT INTO finance.folios(property_id,guest_booking_id) VALUES($1,$2)",
            [propertyId, bookingId],
          );
        }
        async function financialSnapshot() {
          return (
            await admin.query(
              `SELECT
            (SELECT jsonb_agg(to_jsonb(row)) FROM booking.nightly_revenue_evidence row WHERE guest_booking_id=$1) AS revenue,
            (SELECT jsonb_agg(to_jsonb(row)) FROM finance.payments row WHERE guest_booking_id=$1) AS payments,
            (SELECT jsonb_agg(to_jsonb(row)) FROM finance.folios row WHERE guest_booking_id=$1) AS folios`,
              [bookingId],
            )
          ).rows;
        }
        const beforeFinance = await financialSnapshot();
        const beforeInventory = (
          await admin.query(
            "SELECT to_jsonb(day) FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date",
            [propertyId],
          )
        ).rows;
        await expect(
          applyChannexAlterationRevision(admin, change.scope, change.revision),
        ).rejects.toThrow("alteration_finance_reconciliation_required");
        expect(
          (
            await admin.query(
              "SELECT check_out::text,total_amount::text,balance_amount::text FROM booking.guest_bookings WHERE id=$1",
              [bookingId],
            )
          ).rows[0],
        ).toEqual({ check_out: "2026-08-06", total_amount: "25.00", balance_amount: "15.00" });
        expect(
          (
            await admin.query("SELECT status FROM booking.booking_change_requests WHERE id=$1", [
              change.requestId,
            ])
          ).rows[0].status,
        ).toBe("pending");
        expect(
          (
            await admin.query(
              "SELECT to_jsonb(day) FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date",
              [propertyId],
            )
          ).rows,
        ).toEqual(beforeInventory);
        expect(await financialSnapshot()).toEqual(beforeFinance);
        // Even an unchanged total cannot attest to unchanged nightly/tax evidence.
        change.revision.attributes.departure_date = "2026-08-06";
        await admin.query(
          `UPDATE booking.booking_change_requests SET requested_changes=requested_changes || '{"requestedCheckOut":"2026-08-06"}'::jsonb WHERE id=$1`,
          [change.requestId],
        );
        await expect(
          applyChannexAlterationRevision(admin, change.scope, change.revision),
        ).rejects.toThrow("alteration_finance_reconciliation_required");
        expect(
          (
            await admin.query(
              "SELECT adults,balance_amount::text FROM booking.guest_bookings WHERE id=$1",
              [bookingId],
            )
          ).rows[0],
        ).toEqual({ adults: 1, balance_amount: "15.00" });
        expect(await financialSnapshot()).toEqual(beforeFinance);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await admin.query("BEGIN");
    try {
      await admin.query(
        "UPDATE booking.guest_bookings SET total_amount=25,balance_amount=15 WHERE id=$1",
        [bookingId],
      );
      const change = await prepareRevision("2026-08-06");
      await expect(
        applyChannexAlterationRevision(admin, change.scope, change.revision),
      ).resolves.toBe(true);
      expect(
        (
          await admin.query("SELECT balance_amount::text FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows[0].balance_amount,
      ).toBe("15.00");
    } finally {
      await admin.query("ROLLBACK");
    }
    // Application assertions run before rollback, against actual materialized inventory.
    await admin.query("BEGIN");
    try {
      const { scope, revision, requestId, revisionId } = await prepareRevision("2026-08-07");
      const historic = randomUUID();
      await admin.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,currency)
        VALUES($1::uuid,$2,$1::text,'airbnb','confirmed','2026-08-01','2026-08-02','EUR')`,
        [historic, propertyId],
      );
      await admin.query(
        `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,source,room_id)
        VALUES($1,$2,$3,'channel',(SELECT id FROM pms.rooms WHERE property_id=$1 AND room_number='A'))`,
        [propertyId, historic, roomTypeId],
      );
      await expect(
        applyChannexAlterationRevision(admin, scope, {
          ...revision,
          attributes: { ...revision.attributes, amount: "26.00" },
        }),
      ).rejects.toThrow("alteration_revision_proposal_mismatch");
      expect(
        (
          await admin.query(`SELECT status FROM booking.booking_change_requests WHERE id=$1`, [
            requestId,
          ])
        ).rows[0].status,
      ).toBe("pending");
      await admin.query(
        `UPDATE booking.booking_change_requests SET requested_changes=jsonb_set(requested_changes,'{channex,providerState}','"pending"') WHERE id=$1`,
        [requestId],
      );
      await expect(applyChannexAlterationRevision(admin, scope, revision)).rejects.toThrow(
        "alteration_revision_acceptance_unconfirmed",
      );
      await admin.query(
        `UPDATE booking.booking_change_requests SET requested_changes=jsonb_set(requested_changes,'{channex,providerState}','"accepted"') WHERE id=$1`,
        [requestId],
      );
      await admin.query(
        `UPDATE pms.operational_booking_assignments SET assignment_payload='{"version":"reservation-v3"}' WHERE guest_booking_id=$1`,
        [bookingId],
      );
      expect(await applyChannexAlterationRevision(admin, scope, revision)).toBe(true);
      expect(
        (
          await admin.query(
            `SELECT assignment_payload->>'version' AS version FROM pms.operational_booking_assignments WHERE guest_booking_id=$1`,
            [bookingId],
          )
        ).rows,
      ).toEqual([{ version: "reservation-v4" }, { version: "reservation-v4" }]);
      expect(
        (
          await admin.query(
            `SELECT check_out::text,total_amount::text,adults FROM booking.guest_bookings WHERE id=$1`,
            [bookingId],
          )
        ).rows[0],
      ).toEqual({ check_out: "2026-08-07", total_amount: "25.00", adults: 2 });
      expect(
        (
          await admin.query(
            `SELECT check_out::text FROM pms.operational_booking_assignments WHERE guest_booking_id=$1`,
            [bookingId],
          )
        ).rows,
      ).toEqual([{ check_out: "2026-08-07" }, { check_out: "2026-08-07" }]);
      expect(
        (
          await admin.query(
            `SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-06'`,
            [propertyId, roomTypeId],
          )
        ).rows[0].assigned_count,
      ).toBe(2);
      expect(
        (
          await admin.query(
            `SELECT status,requested_changes#>>'{channex,appliedRevisionId}' AS revision FROM booking.booking_change_requests WHERE id=$1`,
            [requestId],
          )
        ).rows[0],
      ).toEqual({ status: "accepted", revision: revisionId });
      const after = (
        await admin.query(
          `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
          [propertyId],
        )
      ).rows;
      expect(await applyChannexAlterationRevision(admin, scope, revision)).toBe(false);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1 AND correlation_id=$2`,
            [propertyId, requestId],
          )
        ).rows[0].count,
      ).toBe(3);
      expect(
        (
          await admin.query(
            `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
            [propertyId],
          )
        ).rows,
      ).toEqual(after);
    } finally {
      await admin.query("ROLLBACK");
    }
    const applied = await prepareRevision("2026-08-05");
    await admin.query(
      "UPDATE booking.guest_bookings SET source_system='pms',source_booking_id=$2 WHERE id=$1",
      [bookingId, `channex:${propertyId}:${applied.providerBookingId}`],
    );
    await admin.query(
      `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,channel,channel_room_index,sync_status)
      VALUES($1,$2,$3,$4,'channex',0,'active'),($1,$2,$3,$4,'channex',1,'active')`,
      [propertyId, connectionId, bookingId, applied.providerBookingId],
    );
    const syntheticRatePlanId = randomUUID();
    const providerRevision = {
      ...applied.revision,
      attributes: {
        ...applied.revision.attributes,
        rooms: applied.revision.attributes.rooms.map((room) => ({
          ...room,
          rate_plan_id: syntheticRatePlanId,
          amount: "18.75",
          days: { "2026-08-04": "18.75" },
          taxes: [],
        })),
        ota_name: "Airbnb",
        channel_id: randomUUID(),
        ota_commission: "3.75",
        inserted_at: new Date().toISOString(),
      },
    };
    const queueRevision = async () =>
      (
        await admin.query(
          `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,payload)
      VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,$3) RETURNING id`,
          [
            randomUUID(),
            applied.providerBookingId,
            {
              propertyId,
              providerPropertyId: applied.scope.providerPropertyId,
              channelBookingId: applied.providerBookingId,
              revision: providerRevision.id,
              revisionSource: "webhook_hint",
              pullRequired: true,
              rawPayload: { event: "booking" },
            },
          ],
        )
      ).rows[0].id as string;
    let acknowledgements = 0;
    let financeEnabled = false;
    let settingsState: "valid" | "missing" | "wrong_binding" = "valid";
    const runRevision = () =>
      runChannexBookingJobs(TEST_DATABASE_URL!, {
        apiBaseUrl: "https://staging.channex.io",
        apiKey: "synthetic-key",
        ownsMutation: () => true,
        applyAirbnbAlterations: true,
        ...(financeEnabled
          ? {
              airbnbFinanceSettings: async (
                _client: unknown,
                identity: {
                  propertyId: string;
                  connectionId: string;
                  bindingGeneration: string;
                  providerPropertyId: string;
                  providerBookingId: string;
                  providerChannelId: string;
                  providerRevisionId: string;
                  providerRevisionAt: string;
                },
              ) =>
                settingsState === "missing"
                  ? null
                  : {
                      ...identity,
                      bindingGeneration:
                        settingsState === "wrong_binding"
                          ? randomUUID()
                          : identity.bindingGeneration,
                      reference: "synthetic-verified-settings",
                      booking_amount_settings: "Payout Amount" as const,
                      cohost_payout_calculations: false,
                    },
            }
          : {}),
        limit: 1,
        fetch: async (_url, init) => {
          if (init?.method === "POST") {
            expect(
              (
                await admin.query(
                  `SELECT check_out::text FROM booking.guest_bookings WHERE id=$1`,
                  [bookingId],
                )
              ).rows[0].check_out,
            ).toBe("2026-08-05");
            acknowledgements++;
            return Response.json({});
          }
          return Response.json({ data: [providerRevision] });
        },
      });
    const jobId = await queueRevision();
    providerRevision.attributes.amount = "26.00";
    expect(await runRevision()).toMatchObject({ retryScheduled: 1 });
    expect(acknowledgements).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT job_metadata->>'lastErrorCode' AS code FROM platform.jobs WHERE id=$1`,
          [jobId],
        )
      ).rows[0].code,
    ).toBe("alteration_revision_proposal_mismatch");
    providerRevision.attributes.amount = "37.50";
    await admin.query(
      `UPDATE booking.booking_change_requests SET requested_changes=requested_changes || '{"newTotal":null,"priceDifference":null}'::jsonb WHERE id=$1`,
      [applied.requestId],
    );
    await admin.query(`UPDATE platform.jobs SET run_after=now() WHERE id=$1`, [jobId]);
    const financePayment = randomUUID();
    await admin.query(
      "INSERT INTO finance.payments(id,property_id,guest_booking_id,payment_kind,status,amount,currency) VALUES($1,$2,$3,'deposit','pending',10,'EUR')",
      [financePayment, propertyId, bookingId],
    );
    try {
      expect(await runRevision()).toMatchObject({ retryScheduled: 1 });
      expect(acknowledgements).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT job_metadata->>'lastErrorCode' AS code FROM platform.jobs WHERE id=$1",
            [jobId],
          )
        ).rows[0].code,
      ).toBe("alteration_finance_reconciliation_required");
    } finally {
      await admin.query("DELETE FROM finance.payments WHERE id=$1", [financePayment]);
    }
    await admin.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [jobId]);
    financeEnabled = true;
    await admin.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Berlin')",
      [propertyId],
    );
    await admin.query("UPDATE platform.jobs SET max_attempts=10 WHERE id=$1", [jobId]);
    for (const invalid of ["missing", "wrong_binding"] as const) {
      settingsState = invalid;
      await admin.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [jobId]);
      expect(await runRevision()).toMatchObject({ retryScheduled: 1 });
      expect(acknowledgements).toBe(0);
      expect(
        (
          await admin.query("SELECT check_out::text FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows[0].check_out,
      ).toBe("2026-08-06");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
            [jobId],
          )
        ).rows[0].code,
      ).toBe("alteration_finance_settings_unavailable");
    }
    settingsState = "valid";
    await admin.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [jobId]);
    const trigger = `alteration_fail_${bookingId.replaceAll("-", "")}`;
    await admin.query(
      `CREATE FUNCTION pms.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.property_id='${propertyId}'::uuid THEN RAISE EXCEPTION 'synthetic mapping failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER ${trigger} BEFORE INSERT ON pms.channel_booking_mappings FOR EACH ROW EXECUTE FUNCTION pms.${trigger}()`,
    );
    try {
      expect(await runRevision()).toMatchObject({ retryScheduled: 1 });
      expect(acknowledgements).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT total_amount::text,balance_amount::text,booking_metadata->>'airbnbMoneyStatus' AS money_status FROM booking.guest_bookings WHERE id=$1",
            [bookingId],
          )
        ).rows[0],
      ).toEqual({ total_amount: "0.00", balance_amount: "0.00", money_status: null });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM finance.ota_commission_evidence WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(`SELECT check_out::text FROM booking.guest_bookings WHERE id=$1`, [
            bookingId,
          ])
        ).rows[0].check_out,
      ).toBe("2026-08-06");
      expect(
        (
          await admin.query(`SELECT status FROM booking.booking_change_requests WHERE id=$1`, [
            applied.requestId,
          ])
        ).rows[0].status,
      ).toBe("pending");
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS count FROM platform.outbox_events WHERE correlation_id=$1`,
            [applied.requestId],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await admin.query(
        `DROP TRIGGER ${trigger} ON pms.channel_booking_mappings; DROP FUNCTION pms.${trigger}()`,
      );
    }
    await admin.query(`UPDATE platform.jobs SET run_after=now() WHERE id=$1`, [jobId]);
    expect(await runRevision()).toMatchObject({ succeeded: 1 });
    expect(
      (
        await admin.query(
          `SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND stay_date='2026-08-05'`,
          [propertyId],
        )
      ).rows[0].assigned_count,
    ).toBe(0);
    const appliedInventory = (
      await admin.query(
        `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
        [propertyId],
      )
    ).rows;
    await queueRevision();
    expect(await runRevision()).toMatchObject({ succeeded: 1 });
    expect(acknowledgements).toBe(2);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT provider_booking_amount::text,ota_commission::text,amount_basis FROM finance.airbnb_current_provider_amounts WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({
      provider_booking_amount: "37.5000",
      ota_commission: "3.7500",
      amount_basis: "Payout Amount",
    });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n,sum(provider_nightly_amount)::text total FROM finance.airbnb_current_provider_nights WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ n: 2, total: "37.5000" });
    const appliedProviderRevision = providerRevision.id;
    {
      financeEnabled = false;
      providerRevision.id = randomUUID();
      providerRevision.attributes.inserted_at = new Date(Date.now() + 1000).toISOString();
      const unsupported = await queueRevision();
      expect(await runRevision()).toMatchObject({ deadLettered: 1 });
      expect(acknowledgements).toBe(2);
      expect(
        (
          await admin.query(
            "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
            [unsupported],
          )
        ).rows[0].code,
      ).toBe("alteration_finance_settings_required");
    }
    expect(
      (
        await admin.query(
          "SELECT total_amount::text,balance_amount::text,booking_metadata->>'airbnbMoneyStatus' AS money_status FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ total_amount: "0.00", balance_amount: "0.00", money_status: "unverified" });
    // Restore the untracked synthetic fixture for the existing generic lifecycle regressions.
    await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
    await admin.query("DELETE FROM finance.ota_commission_evidence WHERE guest_booking_id=$1", [
      bookingId,
    ]);
    await admin.query("DELETE FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1", [
      bookingId,
    ]);
    await admin.query("DELETE FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1", [
      bookingId,
    ]);
    await admin.query("COMMIT");
    financeEnabled = false;
    await admin.query(
      "UPDATE booking.guest_bookings SET total_amount=37.5,balance_amount=37.5,booking_metadata=booking_metadata-'airbnbMoneyStatus' WHERE id=$1",
      [bookingId],
    );
    providerRevision.id = appliedProviderRevision;
    expect(
      (
        await admin.query(
          "SELECT total_amount::text,balance_amount::text FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ total_amount: "37.50", balance_amount: "37.50" });
    expect(
      (
        await admin.query(
          "SELECT requested_changes->'newTotal' AS quote,requested_changes->'priceDifference' AS difference FROM booking.booking_change_requests WHERE id=$1",
          [applied.requestId],
        )
      ).rows[0],
    ).toEqual({ quote: null, difference: null });
    expect(
      (
        await admin.query(
          `SELECT to_jsonb(day) AS data FROM pms.inventory_days day WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
          [propertyId],
        )
      ).rows,
    ).toEqual(appliedInventory);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count FROM platform.outbox_events WHERE correlation_id=$1`,
          [applied.requestId],
        )
      ).rows[0].count,
    ).toBe(3);
    // Exercise an actual alteration followed by ordinary assignment writes in one rollback scope.
    await admin.query("BEGIN");
    try {
      const rateId = randomUUID();
      await admin.query(
        "INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,currency) VALUES($1,$2,$3,'compat','Compatibility','EUR')",
        [rateId, propertyId, roomTypeId],
      );
      await admin.query(
        "INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id) VALUES($1,$2,$3,$4,$5,$6)",
        [propertyId, connectionId, roomTypeId, rateId, externalRoom, syntheticRatePlanId],
      );
      await admin.query(
        'UPDATE pms.operational_booking_assignments SET room_id=NULL,assigned_at=NULL,assignment_status=\'pending\',rate_plan_id=$2,assignment_payload=assignment_payload||\'{"version":"provider-before","channexRevision":"provider-before"}\'::jsonb WHERE guest_booking_id=$1',
        [bookingId, rateId],
      );
      const reducedRequest = randomUUID();
      await admin.query(
        `INSERT INTO booking.booking_change_requests(id,guest_booking_id,request_type,requested_by,requested_changes)
        SELECT $1::uuid,guest_booking_id,request_type,requested_by,jsonb_set(requested_changes,'{channex,eventId}',to_jsonb($1::uuid::text)) || jsonb_build_object(
          'oldCheckOut','2026-08-05','oldTotal','37.50','newTotal','37.50','oldAdults',2,'oldChildren',0,
          'rooms',jsonb_build_array(requested_changes->'rooms'->0))
        FROM booking.booking_change_requests WHERE id=$2`,
        [reducedRequest, applied.requestId],
      );
      const reducedRevision = {
        ...providerRevision,
        id: randomUUID(),
        attributes: {
          ...providerRevision.attributes,
          rooms: [providerRevision.attributes.rooms[0]!],
        },
      };
      await expect(
        applyChannexAlterationRevision(admin, applied.scope, {
          ...reducedRevision,
          attributes: {
            ...reducedRevision.attributes,
            rooms: [{ ...reducedRevision.attributes.rooms[0]!, checkout_date: "2026-08-06" }],
          },
        }),
      ).rejects.toThrow("alteration_revision_proposal_mismatch");
      await admin.query("SAVEPOINT prior_staff_edit");
      await admin.query(
        'UPDATE pms.operational_booking_assignments SET assignment_payload=assignment_payload||\'{"version":"staff-edited"}\'::jsonb WHERE guest_booking_id=$1',
        [bookingId],
      );
      await expect(
        applyChannexAlterationRevision(admin, applied.scope, reducedRevision),
      ).resolves.toBe(true);
      const staffSlot = (
        await admin.query(
          "SELECT assignment_payload AS payload FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 AND position=1",
          [bookingId],
        )
      ).rows[0];
      expect(staffSlot.payload.channexRevision).toBe("provider-before");
      expect(staffSlot.payload.version).not.toBe(staffSlot.payload.channexRevision);
      await admin.query("ROLLBACK TO SAVEPOINT prior_staff_edit");
      await expect(
        applyChannexAlterationRevision(admin, applied.scope, reducedRevision),
      ).resolves.toBe(true);
      const readSlots = async () =>
        (
          await admin.query(
            "SELECT id,position,assignment_status AS status,room_id,assigned_at,assignment_payload AS payload FROM pms.operational_booking_assignments WHERE guest_booking_id=$1 ORDER BY position",
            [bookingId],
          )
        ).rows;
      await admin.query(
        "UPDATE pms.operational_booking_assignments SET room_id=(SELECT id FROM pms.rooms WHERE property_id=$2 AND room_number='B'),assigned_at=now() WHERE guest_booking_id=$1 AND position=2",
        [bookingId, propertyId],
      );
      const reduced = await readSlots();
      expect(reduced[0].payload.channexRevision).toBe(reduced[0].payload.version);
      expect(reduced[0].payload.channexStay).toMatchObject({
        externalRoomTypeId: externalRoom,
        externalRatePlanId: syntheticRatePlanId,
        checkOut: "2026-08-05",
        adults: 1,
      });
      expect(reduced[1].status).toBe("released");
      const roomStay = {
        externalRoomTypeId: externalRoom,
        externalRatePlanId: syntheticRatePlanId,
        checkIn: "2026-08-04",
        checkOut: "2026-08-05",
        adults: 1,
        children: 0,
      };
      const generic = (rooms = [roomStay], canceled = false) =>
        persistChannexAssignments(admin, {
          propertyId,
          connectionId,
          bookingId,
          providerBookingId: applied.providerBookingId,
          revisionId: randomUUID(),
          channel: "airbnb",
          canceled,
          rooms,
        });
      await expect(generic()).resolves.toBe(false);
      expect(await readSlots()).toEqual(reduced);
      await admin.query("SAVEPOINT staff_edit");
      await admin.query(
        'UPDATE pms.operational_booking_assignments SET assignment_payload=assignment_payload||\'{"version":"staff-edited"}\'::jsonb WHERE id=$1',
        [reduced[0].id],
      );
      await expect(generic([{ ...roomStay, adults: 2 }])).rejects.toThrow(
        "operational_assignment_conflict",
      );
      await admin.query("ROLLBACK TO SAVEPOINT staff_edit");
      await expect(generic([{ ...roomStay, adults: 2 }])).resolves.toBe(true);
      expect((await readSlots())[1]).toEqual(reduced[1]);
      await expect(generic([{ ...roomStay, adults: 2 }])).resolves.toBe(false);
      await admin.query("SAVEPOINT reuse_slot");
      await admin.query("UPDATE booking.guest_bookings SET room_count=2 WHERE id=$1", [bookingId]);
      await expect(generic([roomStay, roomStay])).resolves.toBe(true);
      const reused = await readSlots();
      expect(reused[1]).toMatchObject({
        id: reduced[1].id,
        status: "pending",
        room_id: null,
        assigned_at: null,
      });
      expect(reused[1].payload.channexAlterationReleased).toBeUndefined();
      await admin.query("ROLLBACK TO SAVEPOINT reuse_slot");
      // A manually released slot must still block ordinary writes.
      await admin.query("SAVEPOINT untrusted_release");
      await admin.query(
        "UPDATE pms.operational_booking_assignments SET assignment_payload=assignment_payload-'channexAlterationReleased' WHERE id=$1",
        [reduced[1].id],
      );
      await expect(generic([], true)).rejects.toThrow("operational_assignment_conflict");
      await admin.query("ROLLBACK TO SAVEPOINT untrusted_release");
      await expect(generic([], true)).resolves.toBe(true);
      const canceled = await readSlots();
      expect(canceled[0].status).toBe("canceled");
      expect(canceled[1]).toEqual(reduced[1]);
      expect(
        (
          await admin.query(
            "SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-04'",
            [propertyId, roomTypeId],
          )
        ).rows[0].assigned_count,
      ).toBe(0);
    } finally {
      await admin.query("ROLLBACK");
    }
    await book(randomUUID(), "2026-08-06", "2026-08-07");
    await expect(check()).rejects.toThrow("alteration_rooms_unavailable");
    input.changes.requestedCheckOut = "2026-08-06";
    await admin.query(
      `UPDATE pms.room_types SET room_facts_revision=room_facts_revision+1 WHERE id=$1`,
      [roomTypeId],
    );
    await expect(check()).rejects.toThrow("alteration_inventory_not_current");
    // Full tracked sequence: accepted alteration, ordinary modification, cancellation and replay.
    financeEnabled = true;
    await admin.query(
      "UPDATE pms.room_types SET room_facts_revision=room_facts_revision-1 WHERE id=$1",
      [roomTypeId],
    );
    await admin.query(
      "UPDATE booking.guest_bookings SET source_system='pms',source_booking_id=$2 WHERE id=$1",
      [bookingId, `channex:${propertyId}:${applied.providerBookingId}`],
    );
    const workerRate = randomUUID(),
      workerRequest = randomUUID();
    await admin.query(
      "INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,currency) VALUES($1,$2,$3,'worker-compat','Worker compatibility','EUR')",
      [workerRate, propertyId, roomTypeId],
    );
    await admin.query(
      "INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id) VALUES($1,$2,$3,$4,$5,$6)",
      [propertyId, connectionId, roomTypeId, workerRate, externalRoom, syntheticRatePlanId],
    );
    await admin.query(
      `INSERT INTO booking.booking_change_requests(id,guest_booking_id,request_type,requested_by,requested_changes)
      SELECT $1::uuid,guest_booking_id,request_type,requested_by,jsonb_set(requested_changes,'{channex,eventId}',to_jsonb($1::uuid::text)) || jsonb_build_object(
        'oldCheckOut','2026-08-05','oldTotal','37.50','newTotal','37.50','oldAdults',2,'oldChildren',0,
        'rooms',jsonb_build_array(requested_changes->'rooms'->0))
      FROM booking.booking_change_requests WHERE id=$2`,
      [workerRequest, applied.requestId],
    );
    providerRevision.attributes.rooms = [providerRevision.attributes.rooms[0]!];
    Object.assign(providerRevision.attributes.rooms[0]!, { days: { "2026-08-04": "37.50" } });
    let followup = 0;
    const nextWorkerRevision = async () => {
      providerRevision.id = randomUUID();
      providerRevision.attributes.inserted_at = new Date(
        Date.now() + ++followup * 1000,
      ).toISOString();
      const nextJob = await queueRevision();
      const result = await runRevision();
      expect(
        result,
        JSON.stringify(
          (await admin.query("SELECT job_metadata FROM platform.jobs WHERE id=$1", [nextJob])).rows,
        ),
      ).toMatchObject({ succeeded: 1 });
    };
    const rejectTrackedRevision = async (code: string) => {
      providerRevision.id = randomUUID();
      providerRevision.attributes.inserted_at = new Date(
        Date.now() + ++followup * 1000,
      ).toISOString();
      const before = (
        await admin.query(
          "SELECT lifecycle_status,total_amount::text FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        )
      ).rows[0];
      const snapshots = (
        await admin.query(
          "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n;
      const ackBefore = acknowledgements;
      const failedJob = await queueRevision();
      await admin.query("UPDATE platform.jobs SET max_attempts=1 WHERE id=$1", [failedJob]);
      expect(await runRevision()).toMatchObject({ deadLettered: 1 });
      expect(
        (
          await admin.query(
            "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
            [failedJob],
          )
        ).rows[0].code,
      ).toBe(code);
      expect(acknowledgements).toBe(ackBefore);
      expect(
        (
          await admin.query(
            "SELECT lifecycle_status,total_amount::text FROM booking.guest_bookings WHERE id=$1",
            [bookingId],
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(snapshots);
    };
    const originalRule = randomUUID();
    await admin.query(
      "INSERT INTO finance.commission_rules(id,property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel,revision) VALUES($1,$2,'property','pms','percentage',10,'2026-01-01','finance','airbnb',1)",
      [originalRule, propertyId],
    );
    await nextWorkerRevision();
    const historicalRevision = structuredClone(providerRevision);
    expect(await hasBookingFinancialEvidence(admin, { propertyId, bookingId }, true)).toBe(false);
    expect(await hasBookingFinancialEvidence(admin, { propertyId, bookingId })).toBe(true);
    await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
    try {
      await admin.query("DELETE FROM finance.ota_commission_evidence WHERE guest_booking_id=$1", [
        bookingId,
      ]);
      expect(await hasBookingFinancialEvidence(admin, { propertyId, bookingId }, true)).toBe(true);
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query(
      "UPDATE hotel_catalog.properties SET profile_revision=profile_revision+1 WHERE id=$1",
      [propertyId],
    );
    await rejectTrackedRevision("nightly_revenue_evidence_conflict");
    await admin.query(
      "UPDATE hotel_catalog.properties SET profile_revision=profile_revision-1 WHERE id=$1",
      [propertyId],
    );
    // Ordinary modifications must roll back canonical changes when evidence is unavailable.
    providerRevision.attributes.amount = "40.00";
    settingsState = "missing";
    await rejectTrackedRevision("alteration_finance_settings_unavailable");
    settingsState = "valid";
    const protectedPayment = randomUUID();
    await admin.query(
      "INSERT INTO finance.payments(id,property_id,guest_booking_id,payment_kind,status,amount,currency) VALUES($1,$2,$3,'deposit','pending',10,'EUR')",
      [protectedPayment, propertyId, bookingId],
    );
    await rejectTrackedRevision("alteration_finance_reconciliation_required");
    await admin.query("DELETE FROM finance.payments WHERE id=$1", [protectedPayment]);
    providerRevision.attributes.amount = "37.50";
    const originalRevenue = (
      await admin.query(
        "SELECT id FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 ORDER BY source_revision LIMIT 1",
        [bookingId],
      )
    ).rows[0].id;
    await admin.query("BEGIN");
    try {
      await appendExternalNightlyRevenueEconomics(
        admin,
        {
          propertyId,
          guestBookingId: bookingId,
          sourceKind: "ota",
          sourceBookingReference: `channex:${propertyId}:${applied.providerBookingId}`,
          idempotencyKey: randomUUID(),
          lines: [
            {
              roomTypeId,
              stayDate: "2026-08-04",
              recognizedOn: "2026-08-04",
              grossRoomAmount: "100.00",
              occupiedRoomNights: 0,
              economicEvent: "correction",
              lifecycleState: "corrected",
              evidenceQuality: "exact",
              linePosition: 1,
              correctsEvidenceId: originalRevenue,
            },
          ],
        },
        {
          source: {
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: propertyId,
            revision: "profile:1",
          },
          timeZone: "Europe/Berlin",
        },
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    // A later rule must not replace the original correction chain's 10% rule.
    await admin.query("UPDATE finance.commission_rules SET ends_at='2026-07-01' WHERE id=$1", [
      originalRule,
    ]);
    await admin.query(
      "INSERT INTO finance.commission_rules(property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel,revision) VALUES($1,'property','pms','percentage',99,'2026-07-01','finance','airbnb',2)",
      [propertyId],
    );
    const releasedHistory = (
      await admin.query(
        "SELECT to_jsonb(a) AS data FROM pms.operational_booking_assignments a WHERE guest_booking_id=$1 AND position=2",
        [bookingId],
      )
    ).rows;
    expect(releasedHistory[0].data.assignment_status).toBe("released");
    providerRevision.attributes.amount = "40.00";
    providerRevision.attributes.rooms[0]!.amount = "40.00";
    Object.assign(providerRevision.attributes.rooms[0]!, { days: { "2026-08-04": "40.00" } });
    await nextWorkerRevision();
    expect(
      (
        await admin.query(
          "SELECT provider_booking_amount::text amount FROM finance.airbnb_current_provider_amounts WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].amount,
    ).toBe("40.0000");
    expect(
      (
        await admin.query(
          "SELECT total_amount::text,balance_amount::text,booking_metadata->>'airbnbMoneyStatus' AS money_status FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ total_amount: "37.50", balance_amount: "37.50", money_status: "unverified" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].count,
    ).toBe(4);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.ota_commission_evidence WHERE guest_booking_id=$1 AND commission_rule_id IS DISTINCT FROM $2",
          [bookingId, originalRule],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT sum(commission_amount)::text amount FROM finance.ota_commission_evidence WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].amount,
    ).toBe("0.0000");
    Object.assign(providerRevision.attributes, { status: "cancelled", amount: "0.00" });
    Reflect.deleteProperty(providerRevision.attributes, "amount");
    const repeatedCancellationRooms = providerRevision.attributes.rooms;
    providerRevision.attributes.rooms = [];
    settingsState = "wrong_binding";
    await rejectTrackedRevision("alteration_finance_settings_unavailable");
    settingsState = "valid";
    await admin.query(
      "INSERT INTO finance.payments(id,property_id,guest_booking_id,payment_kind,status,amount,currency) VALUES($1,$2,$3,'deposit','pending',10,'EUR')",
      [protectedPayment, propertyId, bookingId],
    );
    await rejectTrackedRevision("alteration_finance_reconciliation_required");
    await admin.query("DELETE FROM finance.payments WHERE id=$1", [protectedPayment]);
    await nextWorkerRevision();
    await queueRevision();
    expect(await runRevision()).toMatchObject({ succeeded: 1 });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.airbnb_current_provider_nights WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT snapshot->>'replacement' replacement,provider_booking_amount::text amount FROM finance.airbnb_current_provider_amounts WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ replacement: "cancellation", amount: null });
    expect(
      (
        await admin.query("SELECT total_amount::text FROM booking.guest_bookings WHERE id=$1", [
          bookingId,
        ])
      ).rows[0].total_amount,
    ).toBe("37.50");
    expect(
      (
        await admin.query("SELECT lifecycle_status FROM booking.guest_bookings WHERE id=$1", [
          bookingId,
        ])
      ).rows[0].lifecycle_status,
    ).toBe("canceled");
    expect(
      (
        await admin.query(
          "SELECT to_jsonb(a) AS data FROM pms.operational_booking_assignments a WHERE guest_booking_id=$1 AND position=2",
          [bookingId],
        )
      ).rows,
    ).toEqual(releasedHistory);
    expect(
      (
        await admin.query(
          "SELECT sum(occupied_room_nights)::int AS nights FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].nights,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.ota_commission_evidence WHERE guest_booking_id=$1 AND corrects_commission_evidence_id IS NOT NULL",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(4);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 AND gross_room_amount<>0",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(2);
    // Some cancellation revisions repeat the stay; absent totals still preserve both amounts.
    providerRevision.attributes.rooms = repeatedCancellationRooms;
    await nextWorkerRevision();
    expect(
      (
        await admin.query(
          "SELECT total_amount::text,balance_amount::text FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        )
      ).rows[0],
    ).toEqual({ total_amount: "37.50", balance_amount: "37.50" });
    expect(
      (
        await admin.query(
          "SELECT provider_booking_amount FROM finance.airbnb_current_provider_amounts WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].provider_booking_amount,
    ).toBeNull();
    const revenueCount = (
      await admin.query(
        "SELECT count(*)::int n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
        [bookingId],
      )
    ).rows[0].n;
    await admin.query("BEGIN");
    try {
      await captureChannexAlterationFinance(
        admin,
        {
          ...applied.scope,
          bookingId,
          rawRevision: historicalRevision,
          providerRevisionAt: historicalRevision.attributes.inserted_at.replace(/Z$/, "000Z"),
          revisionScope: {
            revisionId: historicalRevision.id,
            providerPropertyId: applied.scope.providerPropertyId,
            providerBookingId: applied.providerBookingId,
            currency: "EUR",
            checkIn: "2026-08-04",
            checkOut: "2026-08-05",
            rooms: [{ providerRoomTypeId: externalRoom, roomTypeId }],
          },
        },
        async (_client, identity) => ({
          ...identity,
          reference: "synthetic-verified-settings",
          booking_amount_settings: "Payout Amount",
          cohost_payout_calculations: false,
        }),
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(revenueCount);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM finance.airbnb_current_provider_nights WHERE guest_booking_id=$1",
          [bookingId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  async function channelInventoryFixture(
    horizonDays = 1,
    startAtLocalToday = false,
    includeUnrelatedMappedRoom = false,
  ) {
    const unrelatedRoomTypeId = includeUnrelatedMappedRoom
      ? `00000000-0000-4000-8000-${randomUUID().slice(-12)}`
      : null;
    const f = await createFixture(
      admin,
      repositories,
      [2],
      unrelatedRoomTypeId ? [unrelatedRoomTypeId] : [],
    );
    const date = startAtLocalToday
      ? channexPropertyLocalDate("Europe/Berlin", new Date())!
      : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const through = new Date(`${date}T00:00:00.000Z`);
    through.setUTCDate(through.getUTCDate() + horizonDays - 1);
    await f.repository.materializeInventory(
      materializationCommand(f, "channel-inventory", 1, date, through.toISOString().slice(0, 10)),
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship)
      VALUES($1,'hotel_catalog','property',$2,'owner'),($1,'pms','pms_property',$2,'owner')`,
      [f.organizationId, f.propertyId],
    );
    await admin.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [f.organizationId],
    );
    await admin.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1,'channex',$2,'active','enable')`,
      [f.propertyId, f.propertyId],
    );
    const connectionId = (
      await admin.query(
        `INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status)
      VALUES($1,'channex',$2,'connected') RETURNING id`,
        [f.propertyId, f.propertyId],
      )
    ).rows[0].id;
    const externalRoomTypeId = randomUUID();
    await admin.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
      VALUES($1,$2,$3,$4)`,
      [f.propertyId, connectionId, f.roomTypeId, externalRoomTypeId],
    );
    if (unrelatedRoomTypeId)
      await admin.query(
        `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
         VALUES($1,$2,$3,$4)`,
        [f.propertyId, connectionId, unrelatedRoomTypeId, randomUUID()],
      );
    const jobId = randomUUID();
    await admin.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,attempts_count,locked_by,locked_at,
      tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      VALUES($1::uuid,$1::text,'pms.channex.management','channex.sync_ari','running',1,'inventory-worker',clock_timestamp(),
      'property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"sync_ari"}')`,
      [jobId, f.propertyId],
    );
    await admin.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'inventory-worker')",
      [jobId],
    );
    const lease = { jobId, workerId: "inventory-worker", attemptNumber: 1 },
      selection = { roomTypeId: f.roomTypeId, date };
    return {
      ...f,
      connectionId,
      externalRoomTypeId,
      lease,
      selection,
      prepare: (
        inventory: Pick<
          PmsInventoryMaterializationRepository,
          "getCurrentInventoryDay"
        > = f.repository,
      ) => prepareChannexRoomAvailabilityEvidence(channelPool, inventory, lease, selection),
      claim: (
        inventory: Pick<
          PmsInventoryMaterializationRepository,
          "getCurrentInventoryDay"
        > = f.repository,
      ) => claimChannexRoomAvailability(channelPool, inventory, lease, selection),
      dispatch: (
        inventory: Pick<
          PmsInventoryMaterializationRepository,
          "getCurrentInventoryDay"
        > = f.repository,
      ) => prepareChannexRoomAvailabilityDispatch(channelPool, inventory, lease, selection),
      next: () => prepareNextChannexRoomAvailabilityDispatch(channelPool, f.repository, lease),
    };
  }
  it.each(["sync_ari", "provision"])(
    "uses the restricted Channex login for availability %s",
    async (operation) => {
      const f = await channelInventoryFixture(1, true, operation === "provision");
      if (operation === "provision") {
        const publishedOffer = {
          roomTypeId: randomUUID(),
          offerId: "offer",
          publicationRevision: 1,
          primaryOccupancy: 1,
        };
        await admin.query(
          `UPDATE platform.jobs SET job_type='channex.provision',payload=$2 WHERE id=$1`,
          [f.lease.jobId, JSON.stringify({ operationType: "provision", publishedOffer })],
        );
      }
      const role = CHANNEX_MANAGEMENT_WORKER_ROLE;
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      const login = new URL(TEST_DATABASE_URL!);
      login.username = role;
      login.password = "fixture";
      const worker = new pg.Pool({ connectionString: login.toString() });
      const inventory = f.workerRepository(login.toString());
      try {
        await admin.query(
          `GRANT USAGE ON SCHEMA platform,pms,identity,hotel_catalog,booking,finance TO ${role}`,
        );
        for (const [table, grants] of Object.entries(channexManagementWorkerPrivileges))
          for (const [kind, columns] of Object.entries(grants))
            await admin.query(
              `GRANT ${kind}${columns === true ? "" : `(${columns.join(",")})`} ON ${table} TO ${role}`,
            );
        await admin.query("INSERT INTO platform.channex_management_worker_properties VALUES($1)", [
          f.propertyId,
        ]);
        if (operation === "provision") {
          // The published offer must name the exact mapped room before a provider write is admitted.
          await expect(
            prepareChannexRoomAvailabilityDispatch(worker, inventory, f.lease, f.selection),
          ).rejects.toMatchObject({
            code: "23514",
            message: "Active room mapping and correlated sync job required",
          });
          await admin.query(
            `UPDATE platform.jobs SET payload=jsonb_set(payload,'{publishedOffer,roomTypeId}',to_jsonb($2::text)) WHERE id=$1`,
            [f.lease.jobId, f.roomTypeId],
          );
        }
        const prepared =
          operation === "provision"
            ? await prepareNextChannexRoomAvailabilityDispatch(worker, inventory, f.lease)
            : await prepareChannexRoomAvailabilityDispatch(worker, inventory, f.lease, f.selection);
        expect(prepared.kind).toBe("prepared");
        if (prepared.kind !== "prepared")
          throw new Error("Restricted availability dispatch required");
        if (operation === "provision") expect(prepared).toMatchObject({ roomTypeId: f.roomTypeId });
        const taskId = randomUUID();
        let request: unknown;
        const outcome = await prepared.dispatch(async (sent) => {
          request = sent.body;
          return new Response(
            JSON.stringify({ data: [{ type: "task", id: taskId }], meta: { warnings: [] } }),
          );
        });
        expect(["retained", "receipt_pending"]).toContain(outcome.kind);
        if (outcome.kind === "receipt_pending") await outcome.persist();
        const get = async (path: string) =>
          path.includes("/tasks/")
            ? {
                data: {
                  type: "task",
                  id: taskId,
                  attributes: {
                    id: taskId,
                    task: "Property.UpdateAvailability",
                    payload: request,
                    success: true,
                    errors: [],
                    received_at: "2026-09-16T00:00:00.000001",
                    executed_at: "2026-09-16T00:00:00.000002",
                    finished_at: "2026-09-16T00:00:00.000003",
                  },
                },
              }
            : {
                data: { [f.externalRoomTypeId]: { [f.selection.date]: 2 } },
                meta: { warnings: [] },
              };
        expect(
          await reconcileCurrentChannexRoomAvailability(
            worker,
            inventory,
            f.lease,
            f.selection,
            prepared.attemptId,
            get,
          ),
        ).toEqual({ kind: "availability_reconciled", attemptId: prepared.attemptId });
      } finally {
        await inventory.close();
        await worker.end();
        await admin.query(
          "DELETE FROM platform.channex_management_worker_properties WHERE property_id=$1",
          [f.propertyId],
        );
        await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
    },
  );
  async function availabilityReconciliationFixture(startAtLocalToday = false) {
    const f = await channelInventoryFixture(1, startAtLocalToday),
      prepared = await f.dispatch(),
      taskId = randomUUID();
    if (prepared.kind !== "prepared") throw new Error("dispatch unavailable");
    let request: unknown;
    await prepared.dispatch(async (sent) => {
      request = structuredClone(sent.body);
      return new Response(
        JSON.stringify({ data: [{ type: "task", id: taskId }], meta: { message: "Success" } }),
        { status: 200 },
      );
    });
    if (!request) throw new Error("request unavailable");
    const task = {
      data: {
        type: "task",
        id: taskId,
        attributes: {
          id: taskId,
          task: "Property.UpdateAvailability",
          payload: request,
          success: true,
          errors: [],
          received_at: "2026-09-16T00:00:00.000001",
          executed_at: "2026-09-16T00:00:00.000002",
          finished_at: "2026-09-16T00:00:00.000003",
        },
      },
    };
    const availability = {
      data: { [f.externalRoomTypeId]: { [f.selection.date]: 2 } },
      meta: { warnings: [] },
    };
    const get = vi.fn(async (path: string) =>
      path.includes("/tasks/") ? structuredClone(task) : structuredClone(availability),
    );
    const reconcile = (read: (path: string, signal: AbortSignal) => Promise<unknown> = get) =>
      reconcileCurrentChannexRoomAvailability(
        channelPool,
        f.repository,
        f.lease,
        f.selection,
        prepared.attemptId,
        read,
      );
    const state = async () =>
      (
        await admin.query(
          "SELECT state,reconciliation_evidence FROM pms.channex_room_availability_attempts WHERE id=$1",
          [prepared.attemptId],
        )
      ).rows[0];
    return { ...f, prepared, task, availability, get, reconcile, state };
  }
  async function availabilityContinuationFixture() {
    const f = await availabilityReconciliationFixture();
    const targetState = { succeed: vi.fn(), fail: vi.fn() };
    const store = createPgPmsChannexManagementWorkerStore({
      connectionString: TEST_DATABASE_URL!,
      pool: channelPool,
      targetState,
      ariSyncMutating: false,
    });
    const job = {
      jobId: f.lease.jobId,
      propertyId: f.propertyId,
      correlationId: null,
      attemptNumber: 1,
      maxAttempts: 1,
      input: {
        operationType: "sync_ari" as const,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    };
    await admin.query("UPDATE platform.jobs SET max_attempts=1,payload=$2::jsonb WHERE id=$1", [
      job.jobId,
      JSON.stringify(job.input),
    ]);
    const progress = {
      ok: false as const,
      code: "availability_upload_retained" as const,
      attemptId: f.prepared.attemptId,
    };
    return { ...f, job, progress, store, targetState };
  }
  it("binds canonical inventory to the leased property's current Channex room", async () => {
    const f = await channelInventoryFixture();
    expect(await f.prepare()).toMatchObject({
      kind: "availability_prepared",
      authority: { connectionId: f.connectionId, externalPropertyId: f.propertyId, lease: f.lease },
      mapping: { externalRoomTypeId: f.externalRoomTypeId, bindingGeneration: expect.any(String) },
      inventory: {
        day: {
          propertyId: f.propertyId,
          roomTypeId: f.roomTypeId,
          stayDate: f.selection.date,
          availableCount: 2,
        },
      },
    });
  });
  it("claims the exact canonical count and source evidence for one provider room", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim();
    expect(claimed).toMatchObject({
      kind: "availability_claimed",
      workerId: f.lease.workerId,
      request: {
        method: "POST",
        path: "/api/v1/availability",
        body: {
          values: [
            {
              property_id: f.propertyId,
              room_type_id: f.externalRoomTypeId,
              date_from: f.selection.date,
              date_to: f.selection.date,
              availability: 2,
            },
          ],
        },
      },
    });
    const row = (
      await admin.query(
        `SELECT property_id::text AS "propertyId",room_type_id::text AS "roomTypeId",
          external_property_id AS "externalPropertyId",external_room_type_id AS "externalRoomTypeId",
          service_date::text AS date,available_count AS "availableCount",
          inventory_evidence AS "inventoryEvidence",request_body AS "requestBody",state
         FROM pms.channex_room_availability_attempts WHERE id=$1`,
        [claimed.kind === "availability_claimed" ? claimed.attemptId : null],
      )
    ).rows[0];
    expect(row).toMatchObject({
      propertyId: f.propertyId,
      roomTypeId: f.roomTypeId,
      externalPropertyId: f.propertyId,
      externalRoomTypeId: f.externalRoomTypeId,
      date: f.selection.date,
      availableCount: 2,
      state: "unresolved",
      inventoryEvidence: {
        day: {
          propertyId: f.propertyId,
          roomTypeId: f.roomTypeId,
          stayDate: f.selection.date,
          availableCount: 2,
        },
      },
      requestBody: claimed.kind === "availability_claimed" ? claimed.request.body : null,
    });
  });
  it("does not reuse an unresolved provider-room owner", async () => {
    const f = await channelInventoryFixture();
    expect(await f.claim()).toMatchObject({ kind: "availability_claimed" });
    expect(await f.claim()).toEqual({
      kind: "unavailable",
      reason: "availability_reconciliation_required",
    });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.channex_room_availability_attempts WHERE property_id=$1",
          [f.propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("retains the exact sanitized response for an availability claim", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim();
    expect(claimed.kind).toBe("availability_claimed");
    if (claimed.kind !== "availability_claimed") return;
    const receiptId = randomUUID(),
      taskId = randomUUID(),
      persist = await prepareChannexRoomAvailabilityReceiptPersistence(
        channelPool,
        {
          receiptId,
          attemptId: claimed.attemptId,
          jobAttemptId: claimed.jobAttemptId,
          workerId: claimed.workerId,
          propertyId: f.propertyId,
          connectionId: f.connectionId,
        },
        new Response(
          JSON.stringify({ data: [{ type: "task", id: taskId }], meta: { message: "Success" } }),
          { status: 200, headers: { "x-request-id": "availability.request-1" } },
        ),
      );
    await admin.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.lease.jobId,
    ]);
    await admin.query(
      "UPDATE pms.channel_connections SET connection_status='degraded' WHERE id=$1",
      [f.connectionId],
    );
    await expect(persist()).resolves.toEqual({ kind: "retained", receiptId });
    await expect(persist()).resolves.toEqual({ kind: "retained", receiptId });
    const conflict = await prepareChannexRoomAvailabilityReceiptPersistence(
      channelPool,
      {
        receiptId: randomUUID(),
        attemptId: claimed.attemptId,
        jobAttemptId: claimed.jobAttemptId,
        workerId: claimed.workerId,
        propertyId: f.propertyId,
        connectionId: f.connectionId,
      },
      new Response("not-json", { status: 502 }),
    );
    await expect(conflict()).rejects.toThrow("Channex availability receipt conflict");
    expect(
      (
        await admin.query(
          `SELECT outcome,http_status AS "httpStatus",provider_request_id AS "providerRequestId",
             task_ids AS "taskIds",has_warnings AS "hasWarnings",warning_reason AS "warningReason"
           FROM pms.channex_room_availability_receipts WHERE attempt_id=$1`,
          [claimed.attemptId],
        )
      ).rows[0],
    ).toEqual({
      outcome: "complete_json",
      httpStatus: 200,
      providerRequestId: "availability.request-1",
      taskIds: [taskId],
      hasWarnings: false,
      warningReason: null,
    });
  });
  it("retains ambiguous transport failure without exception text", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim();
    if (claimed.kind !== "availability_claimed") throw new Error("claim unavailable");
    const persist = await prepareChannexRoomAvailabilityTransportFailurePersistence(channelPool, {
      receiptId: randomUUID(),
      attemptId: claimed.attemptId,
      jobAttemptId: claimed.jobAttemptId,
      workerId: claimed.workerId,
      propertyId: f.propertyId,
      connectionId: f.connectionId,
    });
    await persist();
    expect(
      (
        await admin.query(
          "SELECT outcome,http_status,provider_request_id,task_ids,has_warnings,warning_reason FROM pms.channex_room_availability_receipts WHERE attempt_id=$1",
          [claimed.attemptId],
        )
      ).rows[0],
    ).toEqual({
      outcome: "transport_error",
      http_status: null,
      provider_request_id: null,
      task_ids: [],
      has_warnings: true,
      warning_reason: null,
    });
  });
  it("rejects caller-selected availability receipt scope", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim();
    if (claimed.kind !== "availability_claimed") throw new Error("claim unavailable");
    const persist = await prepareChannexRoomAvailabilityTransportFailurePersistence(channelPool, {
      receiptId: randomUUID(),
      attemptId: claimed.attemptId,
      jobAttemptId: claimed.jobAttemptId,
      workerId: claimed.workerId,
      propertyId: randomUUID(),
      connectionId: f.connectionId,
    });
    await expect(persist()).rejects.toThrow("Channex availability receipt correlation unavailable");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.channex_room_availability_receipts WHERE attempt_id=$1",
          [claimed.attemptId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("sends one exact current availability request and retains its receipt", async () => {
    const f = await channelInventoryFixture(),
      prepared = await f.dispatch();
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    const taskId = randomUUID(),
      post = vi.fn(
        async (_request: unknown, _signal: AbortSignal) =>
          new Response(
            JSON.stringify({ data: [{ type: "task", id: taskId }], meta: { message: "Success" } }),
            { status: 200 },
          ),
      );
    await expect(prepared.dispatch(post)).resolves.toEqual({
      kind: "retained",
      attemptId: prepared.attemptId,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][0]).toMatchObject({
      method: "POST",
      path: "/api/v1/availability",
      body: {
        values: [{ availability: 2, date_from: f.selection.date, date_to: f.selection.date }],
      },
    });
    await expect(prepared.dispatch(post)).resolves.toEqual({
      kind: "unavailable",
      reason: "dispatch_already_used",
    });
    expect(post).toHaveBeenCalledOnce();
    expect(
      (
        await admin.query(
          "SELECT outcome,task_ids FROM pms.channex_room_availability_receipts WHERE attempt_id=$1",
          [prepared.attemptId],
        )
      ).rows[0],
    ).toEqual({ outcome: "complete_json", task_ids: [taskId] });
  });
  it("does not send after fresh authority becomes unavailable", async () => {
    const f = await channelInventoryFixture(),
      prepared = await f.dispatch(),
      post = vi.fn();
    if (prepared.kind !== "prepared") throw new Error("dispatch unavailable");
    await admin.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.lease.jobId,
    ]);
    await expect(prepared.dispatch(post)).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_dispatch_stale",
    });
    expect(post).not.toHaveBeenCalled();
    expect(
      (
        await admin.query(
          "SELECT state,reconciliation_evidence FROM pms.channex_room_availability_attempts WHERE id=$1",
          [prepared.attemptId],
        )
      ).rows[0],
    ).toEqual({
      state: "not_sent",
      reconciliation_evidence: {
        schemaVersion: 1,
        reason: "pre_dispatch_verification_unavailable",
      },
    });
    const released = (
      await admin.query(
        `SELECT job_attempt_id::text AS "jobAttemptId",worker_id AS "workerId"
         FROM pms.channex_room_availability_attempts WHERE id=$1`,
        [prepared.attemptId],
      )
    ).rows[0];
    const lateReceipt = await prepareChannexRoomAvailabilityTransportFailurePersistence(
      channelPool,
      {
        receiptId: randomUUID(),
        attemptId: prepared.attemptId,
        jobAttemptId: released.jobAttemptId,
        workerId: released.workerId,
        propertyId: f.propertyId,
        connectionId: f.connectionId,
      },
    );
    await expect(lateReceipt()).rejects.toThrow(
      "Channex availability receipt correlation unavailable",
    );
    await admin.query("UPDATE platform.jobs SET locked_at=clock_timestamp() WHERE id=$1", [
      f.lease.jobId,
    ]);
    await expect(f.dispatch()).resolves.toMatchObject({
      kind: "prepared",
      attemptId: expect.not.stringMatching(prepared.attemptId),
    });
  });
  it("releases a claim when final verification fails before POST", async () => {
    const f = await channelInventoryFixture();
    let reads = 0;
    const inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay"> = {
      getCurrentInventoryDay(input, consume) {
        reads++;
        if (reads === 2) throw new Error("verification unavailable");
        return f.repository.getCurrentInventoryDay(input, consume);
      },
    };
    const prepared = await f.dispatch(inventory),
      post = vi.fn();
    if (prepared.kind !== "prepared") throw new Error("dispatch unavailable");
    await expect(prepared.dispatch(post)).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_dispatch_stale",
    });
    expect(post).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    expect(
      (
        await admin.query("SELECT state FROM pms.channex_room_availability_attempts WHERE id=$1", [
          prepared.attemptId,
        ])
      ).rows[0],
    ).toEqual({ state: "not_sent" });
    await expect(f.dispatch()).resolves.toMatchObject({
      kind: "prepared",
      attemptId: expect.not.stringMatching(prepared.attemptId),
    });
  });
  it("does not reopen an attempt that already has a receipt", async () => {
    const f = await channelInventoryFixture(),
      prepared = await f.dispatch(),
      post = vi.fn();
    if (prepared.kind !== "prepared") throw new Error("dispatch unavailable");
    const attempt = (
      await admin.query(
        `SELECT job_attempt_id::text AS "jobAttemptId",worker_id AS "workerId"
         FROM pms.channex_room_availability_attempts WHERE id=$1`,
        [prepared.attemptId],
      )
    ).rows[0];
    const persist = await prepareChannexRoomAvailabilityTransportFailurePersistence(channelPool, {
      receiptId: randomUUID(),
      attemptId: prepared.attemptId,
      jobAttemptId: attempt.jobAttemptId,
      workerId: attempt.workerId,
      propertyId: f.propertyId,
      connectionId: f.connectionId,
    });
    await persist();
    await expect(prepared.dispatch(post)).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_dispatch_stale",
    });
    expect(post).not.toHaveBeenCalled();
    expect(
      (
        await admin.query("SELECT state FROM pms.channex_room_availability_attempts WHERE id=$1", [
          prepared.attemptId,
        ])
      ).rows[0],
    ).toEqual({ state: "unresolved" });
    await expect(f.claim()).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_reconciliation_required",
    });
  });
  it("retains ambiguous transport failure after invoking the sender", async () => {
    const f = await channelInventoryFixture(),
      prepared = await f.dispatch();
    if (prepared.kind !== "prepared") throw new Error("dispatch unavailable");
    await expect(
      prepared.dispatch(async () => {
        throw new Error("secret transport detail");
      }),
    ).resolves.toMatchObject({ kind: "retained", attemptId: prepared.attemptId });
    expect(
      (
        await admin.query(
          "SELECT outcome,http_status,provider_request_id FROM pms.channex_room_availability_receipts WHERE attempt_id=$1",
          [prepared.attemptId],
        )
      ).rows[0],
    ).toEqual({ outcome: "transport_error", http_status: null, provider_request_id: null });
    await expect(f.claim()).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_reconciliation_required",
    });
  });
  it("reconciles exact task, readback and unchanged PMS evidence", async () => {
    const f = await availabilityReconciliationFixture();
    await expect(f.reconcile()).resolves.toEqual({
      kind: "availability_reconciled",
      attemptId: f.prepared.attemptId,
    });
    expect(f.get.mock.calls.map(([path]) => path)).toEqual([
      expect.stringContaining(`/tasks/${f.task.data.id}`),
      expect.stringContaining("/api/v1/availability?"),
    ]);
    expect(await f.state()).toMatchObject({
      state: "reconciled",
      reconciliation_evidence: {
        schemaVersion: 1,
        originalReceiptId: expect.any(String),
        taskCount: 1,
        observationsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        inventoryEvidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        availability: {
          externalPropertyId: f.propertyId,
          externalRoomTypeId: f.externalRoomTypeId,
          date: f.selection.date,
          availableCount: 2,
        },
      },
    });
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count
           FROM pms.channex_room_availability_reconciliation_attestations
           WHERE attempt_id=$1`,
          [f.prepared.attemptId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(await f.claim()).toMatchObject({ kind: "availability_claimed" });
  });
  it("discovers and reconciles a retained availability write from current lease authority", async () => {
    const f = await availabilityReconciliationFixture();
    await expect(
      reconcilePendingChannexRoomAvailability(channelPool, f.repository, f.lease, f.get),
    ).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    expect(await f.state()).toMatchObject({ state: "reconciled" });
    expect(f.get).toHaveBeenCalledTimes(2);
    await expect(
      reconcilePendingChannexRoomAvailability(channelPool, f.repository, f.lease, f.get),
    ).resolves.toEqual({ kind: "pending_availability_reconciled", count: 0 });
    expect(f.get).toHaveBeenCalledTimes(2);
  });
  it("isolates pending availability writes by current job lease property", async () => {
    const owned = await availabilityReconciliationFixture(),
      foreign = await availabilityReconciliationFixture();
    await expect(
      reconcilePendingChannexRoomAvailability(
        channelPool,
        owned.repository,
        { ...owned.lease, workerId: "stale-worker" },
        owned.get,
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(owned.get).not.toHaveBeenCalled();
    await expect(
      reconcilePendingChannexRoomAvailability(
        channelPool,
        owned.repository,
        owned.lease,
        owned.get,
      ),
    ).resolves.toEqual({ kind: "pending_availability_reconciled", count: 1 });
    expect(await owned.state()).toMatchObject({ state: "reconciled" });
    expect(await foreign.state()).toMatchObject({ state: "unresolved" });
  });
  it("keeps a discovered availability write unresolved when provider readback fails", async () => {
    const f = await availabilityReconciliationFixture(),
      get = vi.fn(async () => {
        throw new Error("readback unavailable");
      });
    await expect(
      reconcilePendingChannexRoomAvailability(channelPool, f.repository, f.lease, get),
    ).rejects.toThrow("readback unavailable");
    expect(await f.state()).toEqual({ state: "unresolved", reconciliation_evidence: {} });
    expect(get).toHaveBeenCalledOnce();
  });
  it("does no provider IO for a discovered non-clean availability receipt", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim(),
      get = vi.fn();
    if (claimed.kind !== "availability_claimed") throw new Error("claim unavailable");
    await (
      await prepareChannexRoomAvailabilityTransportFailurePersistence(channelPool, {
        receiptId: randomUUID(),
        attemptId: claimed.attemptId,
        jobAttemptId: claimed.jobAttemptId,
        workerId: claimed.workerId,
        propertyId: f.propertyId,
        connectionId: f.connectionId,
      })
    )();
    await expect(
      reconcilePendingChannexRoomAvailability(channelPool, f.repository, f.lease, get),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "availability_receipt_history_unavailable",
    });
    expect(get).not.toHaveBeenCalled();
  });
  it("selects the earliest current covered day and creates only a fresh local claim", async () => {
    const f = await channelInventoryFixture(2, true);
    const prepared = await f.next();
    expect(prepared).toMatchObject({
      kind: "prepared",
      roomTypeId: f.roomTypeId,
      date: f.selection.date,
      attemptId: expect.any(String),
    });
    expect(
      (
        await admin.query(
          `SELECT service_date::text AS date,state,
             (SELECT count(*)::int FROM pms.channex_room_availability_receipts receipt
               WHERE receipt.attempt_id=attempt.id) AS receipts
           FROM pms.channex_room_availability_attempts attempt WHERE id=$1`,
          [prepared.kind === "prepared" ? prepared.attemptId : null],
        )
      ).rows[0],
    ).toEqual({ date: f.selection.date, state: "unresolved", receipts: 0 });
  });
  it("skips only exact current reconciled availability evidence", async () => {
    const f = await availabilityReconciliationFixture(true);
    await f.reconcile();
    await expect(
      admin.query(
        `UPDATE pms.channex_room_availability_reconciliation_attestations
         SET observations_sha256=$2 WHERE attempt_id=$1`,
        [f.prepared.attemptId, "f".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(f.next()).resolves.toMatchObject({
      kind: "room_availability_current",
      from: f.selection.date,
      through: f.selection.date,
      roomCount: 1,
      dayCount: 1,
    });
    await admin.query(
      `UPDATE pms.inventory_days SET assigned_count=1,available_count=1,
         booking_source_revision=booking_source_revision+1,
         inventory_revision=inventory_revision+1
       WHERE property_id=$1 AND room_type_id=$2 AND stay_date=$3`,
      [f.propertyId, f.roomTypeId, f.selection.date],
    );
    await expect(f.next()).resolves.toMatchObject({
      kind: "prepared",
      roomTypeId: f.roomTypeId,
      date: f.selection.date,
    });
  });
  it("does not treat an arbitrary storage-level reconciliation as current coverage", async () => {
    const f = await availabilityReconciliationFixture(true);
    const stored = (
      await admin.query(
        `SELECT receipt.id::text AS "receiptId",attempt.inventory_evidence_sha256 AS digest
         FROM pms.channex_room_availability_attempts attempt
         JOIN pms.channex_room_availability_receipts receipt ON receipt.attempt_id=attempt.id
         WHERE attempt.id=$1`,
        [f.prepared.attemptId],
      )
    ).rows[0];
    await admin.query(
      `UPDATE pms.channex_room_availability_attempts
       SET state='reconciled',reconciliation_evidence=$2::jsonb WHERE id=$1`,
      [
        f.prepared.attemptId,
        JSON.stringify({
          schemaVersion: 1,
          completionBasis: "finished_task_fifo",
          originalReceiptId: stored.receiptId,
          taskCount: 1,
          observationsSha256: "0".repeat(64),
          inventoryEvidenceSha256: stored.digest,
          availability: {
            kind: "availability_observed",
            externalPropertyId: f.propertyId,
            externalRoomTypeId: f.externalRoomTypeId,
            date: f.selection.date,
            availableCount: 2,
          },
        }),
      ],
    );
    await expect(f.next()).resolves.toMatchObject({
      kind: "prepared",
      roomTypeId: f.roomTypeId,
      date: f.selection.date,
    });
  });
  it("keeps ownership unresolved when exact provider availability does not match", async () => {
    const f = await availabilityReconciliationFixture();
    f.availability.data[f.externalRoomTypeId]![f.selection.date] = 1;
    await expect(f.reconcile()).rejects.toThrow("availability_readback_mismatch");
    expect(await f.state()).toEqual({ state: "unresolved", reconciliation_evidence: {} });
  });
  it.each(["binding", "inventory"])(
    "rolls back reconciliation when current %s changes during provider reads",
    async (mode) => {
      const f = await availabilityReconciliationFixture();
      const result = await f.reconcile(async (path) => {
        if (path.includes("/tasks/")) {
          if (mode === "binding")
            await admin.query(
              "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE id=$1",
              [f.connectionId],
            );
          else
            await admin.query(
              `UPDATE pms.inventory_days SET assigned_count=1,available_count=1,
               booking_source_revision=1,inventory_revision=inventory_revision+1
             WHERE property_id=$1 AND room_type_id=$2 AND stay_date=$3`,
              [f.propertyId, f.roomTypeId, f.selection.date],
            );
          return structuredClone(f.task);
        }
        return structuredClone(f.availability);
      });
      expect(result).toMatchObject({ kind: "unavailable" });
      expect(await f.state()).toEqual({ state: "unresolved", reconciliation_evidence: {} });
    },
  );
  it("does no provider IO for an ambiguous original receipt", async () => {
    const f = await channelInventoryFixture(),
      claimed = await f.claim(),
      get = vi.fn();
    if (claimed.kind !== "availability_claimed") throw new Error("claim unavailable");
    await (
      await prepareChannexRoomAvailabilityTransportFailurePersistence(channelPool, {
        receiptId: randomUUID(),
        attemptId: claimed.attemptId,
        jobAttemptId: claimed.jobAttemptId,
        workerId: claimed.workerId,
        propertyId: f.propertyId,
        connectionId: f.connectionId,
      })
    )();
    expect(
      await reconcileCurrentChannexRoomAvailability(
        channelPool,
        f.repository,
        f.lease,
        f.selection,
        claimed.attemptId,
        get,
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(get).not.toHaveBeenCalled();
  });
  it("credits an exactly correlated retained availability upload once", async () => {
    const f = await availabilityContinuationFixture();
    await f.store.continueUpload(f.job, f.progress, {
      workerId: f.lease.workerId,
      now: new Date(),
    });
    expect(
      (
        await admin.query(
          "SELECT status,attempts_count,max_attempts,locked_by,finished_at FROM platform.jobs WHERE id=$1",
          [f.job.jobId],
        )
      ).rows[0],
    ).toEqual({
      status: "pending",
      attempts_count: 1,
      max_attempts: 2,
      locked_by: null,
      finished_at: null,
    });
    await expect(
      f.store.continueUpload(f.job, f.progress, {
        workerId: f.lease.workerId,
        now: new Date(),
      }),
    ).rejects.toThrow("Current retained Channex upload required");
    expect(f.targetState.succeed).not.toHaveBeenCalled();
    expect(f.targetState.fail).not.toHaveBeenCalled();
  });
  it("does not credit an availability receipt through the pricing progress lane", async () => {
    const f = await availabilityContinuationFixture();
    await expect(
      f.store.continueUpload(
        f.job,
        { ...f.progress, code: "initial_upload_retained" },
        { workerId: f.lease.workerId, now: new Date() },
      ),
    ).rejects.toThrow("Current retained Channex upload required");
    expect(
      (
        await admin.query("SELECT max_attempts,status FROM platform.jobs WHERE id=$1", [
          f.job.jobId,
        ])
      ).rows[0],
    ).toEqual({ max_attempts: 1, status: "running" });
  });
  it("recovers a retained availability receipt after a final-attempt crash exactly once", async () => {
    const f = await availabilityContinuationFixture();
    const scopedPool = {
      connect: async () => {
        const client = await channelPool.connect();
        return {
          release: client.release.bind(client),
          query: (text: string, values?: unknown[]) =>
            text.includes("pms.enqueue_restriction_ari")
              ? Promise.resolve({ rows: [], rowCount: 0 })
              : client.query(
                  text.includes('max_attempts AS "maxAttempts"')
                    ? text.replace(
                        "WHERE queue_name = $1",
                        `WHERE id='${f.job.jobId}'::uuid AND queue_name = $1`,
                      )
                    : text,
                  values,
                ),
        };
      },
      end: async () => {},
    };
    const recoveringStore = createPgPmsChannexManagementWorkerStore({
      connectionString: TEST_DATABASE_URL!,
      pool: scopedPool,
      targetState: f.targetState,
      ariSyncMutating: true,
    });
    await admin.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.job.jobId,
    ]);
    await expect(
      recoveringStore.claim({ workerId: "replacement", now: new Date() }),
    ).resolves.toMatchObject({ jobId: f.job.jobId, attemptNumber: 2, maxAttempts: 2 });
    await admin.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.job.jobId,
    ]);
    await expect(recoveringStore.claim({ workerId: "third", now: new Date() })).resolves.toBeNull();
    expect(
      (
        await admin.query("SELECT status,max_attempts FROM platform.jobs WHERE id=$1", [
          f.job.jobId,
        ])
      ).rows[0],
    ).toEqual({ status: "dead_lettered", max_attempts: 2 });
  });
  it("writes no owner when current inventory is unavailable", async () => {
    const f = await channelInventoryFixture();
    f.selection.date = "2026-01-01";
    expect(await f.claim()).toMatchObject({ kind: "unavailable" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.channex_room_availability_attempts WHERE property_id=$1",
          [f.propertyId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it.each(["mapping", "binding", "lease", "entitlement"])(
    "holds availability when %s changes before the final guard",
    async (mode) => {
      const f = await channelInventoryFixture();
      expect(
        await f.prepare({
          getCurrentInventoryDay: async (request, guard) => {
            if (mode === "mapping")
              await admin.query(
                "UPDATE pms.channel_room_type_mappings SET external_room_type_id=$2 WHERE property_id=$1",
                [f.propertyId, randomUUID()],
              );
            if (mode === "binding")
              await admin.query(
                "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE id=$1",
                [f.connectionId],
              );
            if (mode === "lease")
              await admin.query(
                "UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1",
                [f.lease.jobId],
              );
            if (mode === "entitlement")
              await admin.query(
                "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 second' WHERE organization_id=$1",
                [f.organizationId],
              );
            return f.repository.getCurrentInventoryDay(request, guard);
          },
        }),
      ).toMatchObject({ kind: "unavailable", reason: "consumer_authority_unavailable" });
    },
  );
  it.each([
    "foreign-room",
    "restrictions-only",
    "disabled-mapping",
    "expired-lease",
    "past-date",
    "degraded-connection",
    "setup-incomplete-connection",
    "uncanonical-property",
  ])("rejects %s availability preparation", async (mode) => {
    const f = await channelInventoryFixture();
    if (mode === "foreign-room") f.selection.roomTypeId = randomUUID();
    if (mode === "restrictions-only")
      await admin.query(
        `UPDATE platform.jobs SET payload=payload || '{"restrictionsOnly":true}'::jsonb WHERE id=$1`,
        [f.lease.jobId],
      );
    if (mode === "disabled-mapping")
      await admin.query(
        "UPDATE pms.channel_room_type_mappings SET status='disabled' WHERE property_id=$1",
        [f.propertyId],
      );
    if (mode === "expired-lease")
      await admin.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
        f.lease.jobId,
      ]);
    if (mode === "past-date") f.selection.date = "2026-01-01";
    if (mode === "degraded-connection" || mode === "setup-incomplete-connection")
      await admin.query("UPDATE pms.channel_connections SET connection_status=$2 WHERE id=$1", [
        f.connectionId,
        mode === "degraded-connection" ? "degraded" : "setup_incomplete",
      ]);
    if (mode === "uncanonical-property") {
      await admin.query("BEGIN");
      try {
        await admin.query(
          "UPDATE pms.channel_binding_claims SET external_property_id=$2 WHERE property_id=$1 AND claim_state='active'",
          [f.propertyId, ` ${f.propertyId} `],
        );
        await admin.query(
          "UPDATE pms.channel_connections SET external_property_id=$2 WHERE id=$1",
          [f.connectionId, ` ${f.propertyId} `],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    expect(await f.prepare()).toMatchObject({ kind: "unavailable" });
    expect(await f.claim()).toMatchObject({ kind: "unavailable" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.channex_room_availability_attempts WHERE property_id=$1",
          [f.propertyId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("does not retain an old calendar snapshot across an inventory writer", async () => {
    const f = await dailyFixture(),
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended(concat('pms-inventory:', $1::uuid::text),0))",
        [f.propertyId],
      );
      await expect(f.read()).rejects.toMatchObject({ code: "55P03" });
      // Model the protected append-only calendar publication while the writer owns inventory.
      await activateCalendarRevision(blocker, f, 2);
      f.calendarState.currentRevision = 1; // The initial unlocked probe is now stale.
      await blocker.query(
        "SELECT pg_advisory_unlock(hashtextextended(concat('pms-inventory:', $1::uuid::text),0))",
        [f.propertyId],
      );
      expect(await f.read()).toMatchObject({
        kind: "unavailable",
        reason: "configuration_not_current",
      });
    } finally {
      await blocker.end();
    }
  });
  it("cannot snapshot old room facts while their writer owns the scope", async () => {
    const f = await dailyFixture(),
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query(
        "SELECT pg_advisory_lock(hashtext('pms.room_facts'),hashtext($1::uuid::text))",
        [f.propertyId],
      );
      await expect(f.read()).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("UPDATE pms.room_types SET room_facts_revision=2 WHERE id=$1", [
        f.roomTypeId,
      ]);
      await blocker.query(
        "SELECT pg_advisory_unlock(hashtext('pms.room_facts'),hashtext($1::uuid::text))",
        [f.propertyId],
      );
      expect(await f.read()).toMatchObject({
        kind: "unavailable",
        reason: "configuration_not_current",
      });
    } finally {
      await blocker.end();
    }
  });
  it("does not accept a reader that omits the transaction guard", async () => {
    const f = await channelInventoryFixture();
    const unguarded = {
      getCurrentInventoryDay: (
        request: Parameters<typeof f.repository.getCurrentInventoryDay>[0],
      ) => f.repository.getCurrentInventoryDay(request),
    };
    expect(await f.prepare(unguarded)).toMatchObject({
      kind: "unavailable",
      reason: "consumer_authority_unavailable",
    });
    expect(await f.claim(unguarded)).toMatchObject({
      kind: "unavailable",
      reason: "consumer_authority_unavailable",
    });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.channex_room_availability_attempts WHERE property_id=$1",
          [f.propertyId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("fails promptly on a concurrent mapping lock inside the inventory guard", async () => {
    const f = await channelInventoryFixture(),
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    try {
      await expect(
        f.prepare({
          getCurrentInventoryDay: async (request, guard) => {
            await blocker.query("BEGIN");
            await blocker.query(
              "SELECT id FROM pms.channel_room_type_mappings WHERE property_id=$1 FOR UPDATE",
              [f.propertyId],
            );
            return f.repository.getCurrentInventoryDay(request, guard);
          },
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("ROLLBACK");
      expect(await f.prepare()).toMatchObject({ kind: "availability_prepared" });
    } finally {
      await blocker.end();
    }
  });
  it("returns no inventory evidence after a guard throws and releases its locks", async () => {
    const f = await channelInventoryFixture(),
      request = { propertyId: f.propertyId, roomTypeId: f.roomTypeId, stayDate: f.selection.date };
    await expect(
      f.repository.getCurrentInventoryDay(request, async () => {
        throw new Error("guard failed");
      }),
    ).rejects.toThrow("guard failed");
    expect(await f.prepare()).toMatchObject({ kind: "availability_prepared" });
  });
  async function dailyFixture(materialize = true) {
    const f = await createFixture(admin, repositories, [2, 1]);
    if (materialize)
      await f.repository.materializeInventory(
        materializationCommand(f, "daily-reader", 1, "2026-08-04", "2026-08-06"),
      );
    const request = { propertyId: f.propertyId, roomTypeId: f.roomTypeId, stayDate: "2026-08-04" };
    return { ...f, request, read: () => f.repository.getCurrentInventoryDay(request) };
  }
  it("reads canonical daily counts and owner revisions without modifying inventory", async () => {
    const f = await dailyFixture();
    expect(await f.read()).toMatchObject({
      kind: "available",
      materializedRevision: 1,
      propertyTimeZone: "Europe/Berlin",
      sourceRoomFactsRevision: 1,
      sourceRoomUnitsRevision: 1,
      day: { ...f.request, availableCount: 2, inventoryRevision: 1 },
    });
    await consumeAndOverrideFirstDay(admin, f);
    const before = await readFirstDay(admin, f);
    expect(await f.read()).toMatchObject({
      kind: "available",
      day: {
        availableCount: 0,
        assignedCount: 2,
        manualSellableLimitCount: 1,
        inventoryRevision: 3,
        sourceRevisions: { booking: 1, manual: 1 },
      },
    });
    expect(await readFirstDay(admin, f)).toEqual(before);
  });
  it("returns a verified zero for a linked stop-sell day", async () => {
    const f = await dailyFixture();
    await admin.query(
      `UPDATE pms.inventory_days SET available_count=0,inventory_revision=inventory_revision+1,
      linked_stop_sell=true,linked_source_revision=1 WHERE property_id=$1 AND room_type_id=$2`,
      [f.propertyId, f.roomTypeId],
    );
    expect(await f.read()).toMatchObject({
      kind: "available",
      day: { availableCount: 0, linkedStopSell: true, linkedSourceRevision: 1 },
    });
  });
  it.each([
    "calendar",
    "profile",
    "capacity",
    "room-facts",
    "missing-day",
    "coverage",
    "foreign-room",
    "foreign-property",
    "invalid-date",
  ])("does not manufacture availability for %s", async (mode) => {
    const f = await dailyFixture(mode !== "missing-day");
    if (mode === "calendar") await activateCalendarRevision(admin, f, 2);
    if (mode === "profile") f.profileState.revision = 2;
    if (mode === "capacity") f.capacityState.revision = 2;
    if (mode === "room-facts")
      await admin.query("UPDATE pms.room_types SET room_facts_revision=2 WHERE id=$1", [
        f.roomTypeId,
      ]);
    if (mode === "coverage") f.request.stayDate = "2026-08-07";
    if (mode === "foreign-room") f.request.roomTypeId = randomUUID();
    if (mode === "foreign-property") f.request.propertyId = randomUUID();
    if (mode === "invalid-date") f.request.stayDate = "2026-02-30";
    expect(await f.read()).toMatchObject({ kind: "unavailable" });
  });
  it("does not read across a concurrent inventory mutation", async () => {
    const f = await dailyFixture(),
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(concat('pms-inventory:', $1::uuid::text), 0))",
        [f.propertyId],
      );
      await expect(f.read()).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("ROLLBACK");
      expect(await f.read()).toMatchObject({ kind: "available" });
    } finally {
      await blocker.end();
    }
  });
  it("rejects captured active-room evidence after closure without writing inventory", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    await admin.query(
      `INSERT INTO pms.room_type_closures
      (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,
       expected_room_units_revision,previous_calendar_revision,closed_calendar_revision,
       cutoff_date,accepted_at,actor_user_id)
      VALUES ($1,$2,$3,$4,1,1,1,2,'2026-08-04',now(),$5)`,
      [fixture.propertyId, fixture.roomTypeId, randomUUID(), "a".repeat(64), fixture.actorUserId],
    );
    expect(
      await fixture.repository.materializeInventory(
        materializationCommand(fixture, "closed", 1, "2026-08-04", "2026-08-06"),
      ),
    ).toMatchObject({ ok: false, error: { code: "configuration_not_current" } });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pms.inventory_days WHERE property_id=$1",
          [fixture.propertyId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it("adds a new room to stored coverage and still rejects missing old-room rows", async () => {
    const newRoom = randomUUID();
    const additionalRoomTypes: string[] = [];
    const fixture = await createFixture(admin, repositories, [2, 2], additionalRoomTypes);
    await fixture.repository.materializeInventory(
      materializationCommand(fixture, "before-add", 1, "2026-08-04", "2026-08-06"),
    );
    await admin.query(
      "UPDATE pms.inventory_days SET assigned_count=1, available_count=1, booking_source_revision=1, inventory_revision=2 WHERE property_id=$1 AND stay_date='2026-08-05'",
      [fixture.propertyId],
    );
    await admin.query(
      "INSERT INTO pms.room_types (id,property_id,name) VALUES ($1,$2,'New room')",
      [newRoom, fixture.propertyId],
    );
    additionalRoomTypes.push(newRoom);
    const next = fixture.configurations.get(2)!;
    (fixture.configurations as Map<number, PmsOperatingCalendarConfigurationSnapshot>).set(2, {
      ...next,
      sourceInputs: {
        ...next.sourceInputs,
        roomBindings: [
          ...next.sourceInputs.roomBindings,
          { ...next.sourceInputs.roomBindings[0]!, roomTypeId: newRoom },
        ].sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId)),
      },
    });
    await activateCalendarRevision(admin, fixture, 2);
    for (const [from, through] of [
      ["2026-08-04", "2026-08-05"],
      ["2026-08-05", "2026-08-06"],
    ]) {
      await expect(
        fixture.repository.materializeInventory(
          materializationCommand(fixture, `partial-add-${from}`, 2, from!, through!),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "inventory_invariant_violation" } });
    }
    expect(
      (
        await admin.query(
          "SELECT calendar_revision FROM pms.inventory_materialization_coverage WHERE property_id=$1",
          [fixture.propertyId],
        )
      ).rows,
    ).toEqual([{ calendar_revision: 1 }]);
    const command = materializationCommand(fixture, "add-room", 2, "2026-08-04", "2026-08-06");
    const result = await fixture.repository.materializeInventory(command);
    expect(result).toMatchObject({ ok: true, outcome: "rematerialized" });
    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual(result);
    const rows = await admin.query(
      "SELECT room_type_id,stay_date::text,assigned_count,available_count FROM pms.inventory_days WHERE property_id=$1",
      [fixture.propertyId],
    );
    expect(rows.rows).toHaveLength(6);
    expect(
      rows.rows.find((r) => r.room_type_id === fixture.roomTypeId && r.stay_date === "2026-08-05"),
    ).toMatchObject({ assigned_count: 1, available_count: 1 });
    await expect(
      admin.query(
        "DELETE FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-08-05'",
        [fixture.propertyId, fixture.roomTypeId],
      ),
    ).rejects.toThrow("inventory materialization coverage is not exact and gap-free");
  });

  it("applies, replays, extends, and rematerializes without erasing retained owners", async () => {
    const fixture = await createFixture(admin, repositories, [2, 1]);
    const first = materializationCommand(fixture, "first", 1, "2026-08-04", "2026-08-06");

    const applied = await fixture.repository.materializeInventory(first);
    expect(applied).toMatchObject({
      ok: true,
      outcome: "applied",
      changedDayCount: 3,
      projectionRefreshIntent: {
        eventType: "pms.inventory.projection_refresh_requested",
        reason: "full_horizon_apply",
        roomTypeIds: [fixture.roomTypeId],
      },
    });
    await expect(fixture.repository.materializeInventory(first)).resolves.toEqual(applied);
    await expect(
      fixture.repository.materializeInventory({
        ...first,
        horizon: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
    expect(
      (
        await admin.query(
          `SELECT payload FROM platform.outbox_events
           WHERE property_id=$1 AND destination='pms.channel-manager'
             AND event_type='pms.inventory.ari_changed'`,
          [fixture.propertyId],
        )
      ).rows,
    ).toEqual([{ payload: expect.objectContaining({ reason: "full_horizon_apply" }) }]);

    const unchanged = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "unchanged", 1, "2026-08-04", "2026-08-06"),
    );
    expect(unchanged).toMatchObject({
      ok: true,
      outcome: "unchanged",
      changedDayCount: 0,
      projectionRefreshIntent: null,
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 2,
      idempotency: 2,
      events: 1,
      outbox: 1,
    });

    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-06" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });

    await consumeAndOverrideFirstDay(admin, fixture);
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-06" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });

    const extended = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "extend", 1, "2026-08-04", "2026-08-07"),
    );
    expect(extended).toMatchObject({
      ok: true,
      outcome: "extended",
      changedDayCount: 1,
      projectionRefreshIntent: { reason: "horizon_extension" },
    });
    await expect(readFirstDay(admin, fixture)).resolves.toMatchObject({
      assignedCount: 2,
      bookingRevision: 1,
      manualLimit: 1,
      manualRevision: 1,
      inventoryRevision: 3,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: 0,
    });

    await activateCalendarRevision(admin, fixture, 2);
    const rematerialized = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "revision-two", 2, "2026-08-04", "2026-08-07"),
    );
    expect(rematerialized).toMatchObject({
      ok: true,
      outcome: "rematerialized",
      changedDayCount: 4,
      projectionRefreshIntent: { reason: "rematerialization", materializedRevision: 2 },
    });
    await expect(readFirstDay(admin, fixture)).resolves.toEqual({
      calendarRevision: 2,
      inventoryRevision: 4,
      generatedLimit: 1,
      generatedRevision: 2,
      assignedCount: 2,
      bookingRevision: 1,
      manualLimit: 1,
      manualRevision: 1,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: 0,
    });
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });
    fixture.calendarState.readCount = 0;
    fixture.calendarState.staleOnRead = 2;
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toBeNull();
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 4,
      idempotency: 4,
      events: 3,
      outbox: 3,
    });
  });

  it("finishes an earlier partial rematerialization at the current calendar revision", async () => {
    const fixture = await createFixture(admin, repositories, [2, 1]);
    await fixture.repository.materializeInventory(
      materializationCommand(fixture, "initial-full", 1, "2026-08-04", "2026-08-07"),
    );
    await activateCalendarRevision(admin, fixture, 2);
    await expect(
      fixture.repository.materializeInventory(
        materializationCommand(fixture, "partial-new", 2, "2026-08-04", "2026-08-05"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "rematerialized" });
    const retained = await readFirstDay(admin, fixture);
    const command = materializationCommand(fixture, "finish-new", 2, "2026-08-04", "2026-08-07");
    const completed = await fixture.repository.materializeInventory(command);
    expect(completed).toMatchObject({ ok: true, outcome: "rematerialized", changedDayCount: 2 });
    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual(completed);
    await expect(readFirstDay(admin, fixture)).resolves.toEqual(retained);
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });
  });

  it("stop-sells newly extended dates for an existing linked cause", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const groupId = randomUUID();
    const sourceRoomTypeId = randomUUID();
    await admin.query(
      `INSERT INTO pms.linked_inventory_groups (id, property_id, name)
       VALUES ($1::uuid, $2::uuid, 'Convertible rooms')`,
      [groupId, fixture.propertyId],
    );
    await admin.query(
      "UPDATE pms.room_types SET linked_inventory_group_id=$1::uuid WHERE id=$2::uuid",
      [groupId, fixture.roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (id, property_id, name, active, linked_inventory_group_id)
       VALUES ($1::uuid, $2::uuid, 'Linked source', false, $3::uuid)`,
      [sourceRoomTypeId, fixture.propertyId, groupId],
    );
    await admin.query(
      `INSERT INTO pms.room_blocks
         (property_id, room_type_id, starts_on, ends_on, reason)
       VALUES ($1::uuid, $2::uuid, DATE '2026-08-04', DATE '2026-08-07', 'Maintenance')`,
      [fixture.propertyId, sourceRoomTypeId],
    );

    const initial = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "linked-initial", 1, "2026-08-04", "2026-08-05"),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    expect(initial).toMatchObject({ ok: true, outcome: "applied", changedDayCount: 2 });
    const extension = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "linked-extend", 1, "2026-08-04", "2026-08-07"),
    );
    if (!extension.ok) throw new Error(extension.error.code);
    expect(extension).toMatchObject({ ok: true, outcome: "extended", changedDayCount: 2 });

    await expect(
      admin.query(
        `SELECT linked_stop_sell AS stopped, linked_source_revision AS revision,
                available_count AS available
         FROM pms.inventory_days
         WHERE property_id=$1::uuid AND room_type_id=$2::uuid
         ORDER BY stay_date`,
        [fixture.propertyId, fixture.roomTypeId],
      ),
    ).resolves.toMatchObject({
      rows: Array.from({ length: 4 }, () => ({ stopped: true, revision: 1, available: 0 })),
    });
    await expect(
      admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM platform.outbox_events
         WHERE property_id=$1::uuid AND resource_type='linked_inventory'`,
        [fixture.propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 6 }] });
  });

  it("persists the complete 366-day launch horizon", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const result = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "full-horizon", 1, "2026-08-04", "2027-08-04"),
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: "applied",
      changedDayCount: 366,
      coverage: { expectedDayCount: 366, materializedDayCount: 366, gaps: [] },
    });
    expect(fixture.calendarState.readCount).toBe(0);
    const count = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pms.inventory_days
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    expect(count.rows[0]?.count).toBe("366");
  });

  it("serializes concurrent exact commands to one durable mutation and one receipt-free replay", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "concurrent", 1, "2026-08-04", "2026-08-06");

    const [left, right] = await Promise.all([
      fixture.repository.materializeInventory(command),
      fixture.repository.materializeInventory(command),
    ]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({ ok: true, outcome: "applied", changedDayCount: 3 });
    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("shares the established property inventory lock identity with legacy inventory writers", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await blocker.connect();
    try {
      const blockerProcessId = await backendProcessId(blocker);
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(concat('pms-inventory:', $1::text), 0)
         )`,
        [fixture.propertyId],
      );
      const pending = fixture.repository.materializeInventory(
        materializationCommand(fixture, "legacy-lock", 1, "2026-08-04", "2026-08-04"),
      );
      void pending.catch(() => {});
      await waitForLockWaiter(admin, blockerProcessId);
      await blocker.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ ok: true, outcome: "applied" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("reauthorizes before replay and fails closed without exposing the stored result", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "reauthorize", 1, "2026-08-04", "2026-08-04");
    await expect(fixture.repository.materializeInventory(command)).resolves.toMatchObject({
      ok: true,
    });

    fixture.authorizationState.allowed = false;
    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual({
      ok: false,
      error: { code: "configuration_not_found" },
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("rejects a self-consistent stored replay that escapes the authorized organization", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "bound-replay", 1, "2026-08-04", "2026-08-04");
    const applied = await fixture.repository.materializeInventory(command);
    if (!applied.ok || !applied.projectionRefreshIntent) {
      throw new Error("Expected changed materialization result");
    }
    const stored = JSON.parse(JSON.stringify(applied)) as Record<string, unknown>;
    const intent = stored["projectionRefreshIntent"] as Record<string, unknown>;
    intent["organizationId"] = randomUUID();
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $2::jsonb),
           response_body_hash = $3
       WHERE property_id = $1::uuid AND operation = 'pms.inventory.materialize'`,
      [fixture.propertyId, JSON.stringify(stored), sha256(stableJson(stored))],
    );

    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("rejects stale evidence and adopts only pristine onboarding inventory", async () => {
    const newerCalendar = await createFixture(admin, repositories, [2, 1]);
    await activateCalendarRevision(admin, newerCalendar, 2);
    await expect(
      newerCalendar.repository.materializeInventory(
        materializationCommand(newerCalendar, "newer-calendar", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, newerCalendar.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, newerCalendar.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const staleProfile = await createFixture(admin, repositories, [2]);
    staleProfile.profileState.revision = 2;
    await expect(
      staleProfile.repository.materializeInventory(
        materializationCommand(staleProfile, "stale-profile", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, staleProfile.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, staleProfile.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const staleCapacity = await createFixture(admin, repositories, [2]);
    staleCapacity.capacityState.count = 3;
    await expect(
      staleCapacity.repository.materializeInventory(
        materializationCommand(staleCapacity, "stale-capacity", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, staleCapacity.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, staleCapacity.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const legacy = await createFixture(admin, repositories, [2]);
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-08-04', 2, 0, 0, 2, 'open',
         jsonb_build_object('pms', jsonb_build_object(
           'status', 'fresh', 'generatedAt', $3::timestamptz, 'horizonDays', 366
         ))
       )`,
      [legacy.propertyId, legacy.roomTypeId, ACCEPTED_AT.toISOString()],
    );
    await expect(
      legacy.repository.materializeInventory(
        materializationCommand(legacy, "legacy", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "applied", changedDayCount: 1 });
    const stored = await admin.query<{ calendarRevision: number | null; sourceFreshness: unknown }>(
      `SELECT calendar_revision AS "calendarRevision", source_freshness AS "sourceFreshness"
       FROM pms.inventory_days WHERE property_id = $1::uuid`,
      [legacy.propertyId],
    );
    expect(stored.rows).toEqual([
      {
        calendarRevision: 1,
        sourceFreshness: {
          pms: { status: "fresh", generatedAt: expect.any(String), horizonDays: 366 },
        },
      },
    ]);
    await expect(sideEffectCounts(admin, legacy.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });

    const occupiedLegacy = await createFixture(admin, repositories, [2]);
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-08-04', 2, 1, 0, 1, 'open',
         jsonb_build_object('pms', jsonb_build_object(
           'status', 'fresh', 'generatedAt', $3::timestamptz, 'horizonDays', 366
         ))
       )`,
      [occupiedLegacy.propertyId, occupiedLegacy.roomTypeId, ACCEPTED_AT.toISOString()],
    );
    await expect(
      occupiedLegacy.repository.materializeInventory(
        materializationCommand(occupiedLegacy, "occupied-legacy", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "inventory_invariant_violation" } });
    await expect(sideEffectCounts(admin, occupiedLegacy.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    for (const [suffix, freshness] of [
      [
        "extra-source-key",
        {
          pms: { status: "fresh", generatedAt: ACCEPTED_AT.toISOString(), horizonDays: 366 },
          other: {},
        },
      ],
      [
        "extra-pms-key",
        {
          pms: {
            status: "fresh",
            generatedAt: ACCEPTED_AT.toISOString(),
            horizonDays: 366,
            other: true,
          },
        },
      ],
      [
        "noncanonical-timestamp",
        { pms: { status: "fresh", generatedAt: "Aug 4 2026 10:00 UTC", horizonDays: 366 } },
      ],
      [
        "overflow-timestamp",
        { pms: { status: "fresh", generatedAt: "2026-02-31T24:00:00Z", horizonDays: 366 } },
      ],
    ] as const) {
      const malformed = await createFixture(admin, repositories, [2]);
      await admin.query(
        `INSERT INTO pms.inventory_days (
           property_id, room_type_id, stay_date, total_count,
           assigned_count, blocked_count, available_count, status, source_freshness
         ) VALUES ($1::uuid, $2::uuid, DATE '2026-08-04', 2, 0, 0, 2, 'open', $3::jsonb)`,
        [malformed.propertyId, malformed.roomTypeId, JSON.stringify(freshness)],
      );
      await expect(
        malformed.repository.materializeInventory(
          materializationCommand(malformed, suffix, 1, "2026-08-04", "2026-08-04"),
        ),
      ).resolves.toEqual({ ok: false, error: { code: "inventory_invariant_violation" } });
    }
  });
});

async function createFixture(
  admin: Pick<pg.PoolClient, "query">,
  repositories: PmsInventoryMaterializationRepository[],
  startingLimits: readonly number[],
  additionalRoomTypes: readonly string[] = [],
): Promise<Fixture> {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const actorUserId = randomUUID();
  await admin.query(
    `INSERT INTO identity.organizations (id, kind, name, slug)
     VALUES ($1::uuid, 'hotel_group', 'VAY-1063 Test', $2)`,
    [organizationId, `vay-1063-${organizationId}`],
  );
  await admin.query(
    `INSERT INTO identity.users (id, email, name)
     VALUES ($1::uuid, $2, 'VAY-1063 Test')`,
    [actorUserId, `${actorUserId}@example.test`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-1063 Test')`,
    [propertyId, `vay-1063-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name)
     VALUES ($1::uuid, $2::uuid, 'Room')`,
    [roomTypeId, propertyId],
  );

  for (const id of additionalRoomTypes) {
    await admin.query(
      "INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Additional room')",
      [id, propertyId],
    );
  }
  const configurations = new Map<number, PmsOperatingCalendarConfigurationSnapshot>();
  for (let index = 0; index < startingLimits.length; index += 1) {
    const revision = index + 1;
    const configuration = configurationSnapshot({
      propertyId,
      roomTypeId,
      revision,
      startingLimit: startingLimits[index]!,
      additionalRoomTypes,
    });
    configurations.set(revision, configuration);
    if (revision === 1) {
      await seedCalendarRevision(admin, {
        organizationId,
        propertyId,
        roomTypeId,
        actorUserId,
        revision,
        startingLimit: startingLimits[index]!,
        additionalRoomTypes,
      });
    }
  }

  const calendarState = {
    currentRevision: 1,
    stale: false,
    readCount: 0,
    staleOnRead: null as number | null,
  };
  const capacityState = { revision: 1, count: 2 };
  const profileState = { available: true, revision: 1 };
  const authorizationState = { allowed: true };
  const authorize = vi.fn(async () => authorizationState.allowed);
  const authorization: PmsInventoryMaterializationAuthorizationPort = {
    authorizeInventoryMaterialization: authorize,
  };
  const operatingCalendar: PmsOperatingCalendarReadPort = {
    async getCurrentOperatingCalendarConfiguration(requestedPropertyId) {
      if (requestedPropertyId !== propertyId) return null;
      calendarState.readCount += 1;
      if (calendarState.readCount === calendarState.staleOnRead) calendarState.stale = true;
      const configuration = configurations.get(calendarState.currentRevision);
      if (!configuration) return null;
      return calendarState.stale
        ? {
            configuration,
            sourceStatus: "stale",
            sourceConflicts: [
              { code: "room_units_revision_conflict", roomTypeId, currentRevision: 2 },
            ],
          }
        : { configuration, sourceStatus: "current", sourceConflicts: [] };
    },
    async getOperatingCalendarConfigurationBySource(source) {
      if (source.entityId !== propertyId) return null;
      const revision = Number(source.revision.slice("calendar:".length));
      return configurations.get(revision) ?? null;
    },
  };
  const roomCapacity: RoomCapacityReadPort = {
    async getRoomTypeCapacity(requestedPropertyId, requestedRoomTypeId) {
      return requestedPropertyId === propertyId &&
        [roomTypeId, ...additionalRoomTypes].includes(requestedRoomTypeId)
        ? {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: requestedRoomTypeId,
            roomUnitsRevision: capacityState.revision,
            activeUnitCount: capacityState.count,
            capturedAt: ACCEPTED_AT.toISOString(),
          }
        : null;
    },
  };
  const propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort = {
    ownerDomain: "hotel_catalog",
    registryVersion: "test.v1",
    isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
    async runWithPropertyProfileEvidence(_input, guarded) {
      const configuration = configurations.get(calendarState.currentRevision);
      if (!configuration) throw new Error("Missing current test configuration");
      const source = {
        ownerDomain: "hotel_catalog" as const,
        entityType: "property_profile" as const,
        entityId: propertyId,
        revision: `profile:${profileState.revision}`,
      };
      return guarded(
        profileState.available
          ? {
              status: "available",
              evidence: {
                source,
                timeZone: configuration.sourceInputs.propertyTimeZone,
              },
            }
          : { status: "timezone_missing", source },
      );
    },
  };
  const repository = createPgPmsInventoryMaterializationRepository({
    connectionString: TEST_DATABASE_URL!,
    max: 4,
    now: () => ACCEPTED_AT,
    authorization,
    operatingCalendar,
    propertyProfileEvidence,
    roomCapacity,
  });
  repositories.push(repository);
  return {
    organizationId,
    propertyId,
    roomTypeId,
    actorUserId,
    configurations,
    calendarState,
    capacityState,
    profileState,
    authorizationState,
    authorize,
    repository,
    workerRepository: (connectionString) =>
      createPgPmsInventoryMaterializationRepository({
        connectionString,
        authorization,
        operatingCalendar,
        propertyProfileEvidence,
        roomCapacity,
      }),
  };
}

async function activateCalendarRevision(
  admin: Pick<pg.PoolClient, "query">,
  fixture: Fixture,
  revision: number,
): Promise<void> {
  const configuration = fixture.configurations.get(revision);
  const binding = configuration?.sourceInputs.roomBindings[0];
  if (!configuration || !binding) throw new Error("Missing calendar revision fixture");
  await seedCalendarRevision(admin, {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    roomTypeId: fixture.roomTypeId,
    actorUserId: fixture.actorUserId,
    revision,
    startingLimit: binding.startingSellableLimitCount,
    roomTypeIds: configuration.sourceInputs.roomBindings.map((b) => b.roomTypeId),
  });
  fixture.calendarState.currentRevision = revision;
}

function configurationSnapshot(input: {
  propertyId: string;
  roomTypeId: string;
  revision: number;
  startingLimit: number;
  additionalRoomTypes?: readonly string[];
}): PmsOperatingCalendarConfigurationSnapshot {
  const parsed = parsePmsOperatingCalendarConfigurationSnapshot(
    {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      propertyId: input.propertyId,
      calendarRevision: input.revision,
      source: createPmsOperatingCalendarSourceRevision(input.propertyId, input.revision),
      sourceInputs: {
        propertyProfile: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: input.propertyId,
          revision: "profile:1",
        },
        propertyTimeZone: "Europe/Berlin",
        roomBindings: [input.roomTypeId, ...(input.additionalRoomTypes ?? [])]
          .sort()
          .map((roomTypeId) => ({
            roomTypeId,
            sourceRoomFactsRevision: 1,
            sourceRoomUnitsRevision: 1,
            physicalCapacityCount: 2,
            startingSellableLimitCount: input.startingLimit,
          })),
      },
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
      createdAt: ACCEPTED_AT.toISOString(),
      updatedAt: ACCEPTED_AT.toISOString(),
    },
    {
      ownerDomain: "hotel_catalog",
      registryVersion: "test.v1",
      isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
    },
  );
  if (!parsed) throw new Error("Test operating calendar configuration is invalid");
  return parsed;
}

async function seedCalendarRevision(
  admin: Pick<pg.PoolClient, "query">,
  input: {
    organizationId: string;
    propertyId: string;
    roomTypeId: string;
    actorUserId: string;
    revision: number;
    startingLimit: number;
    additionalRoomTypes?: readonly string[];
    roomTypeIds?: readonly string[];
  },
): Promise<void> {
  const idempotencyId = randomUUID();
  const eventId = randomUUID();
  const outboxId = randomUUID();
  await admin.query(
    `INSERT INTO platform.idempotency_keys (
       id, operation_scope, operation, key_hash, request_fingerprint_hash,
       status, tenant_scope, property_id, first_seen_at, last_seen_at, expires_at
     ) VALUES (
       $1::uuid, 'pms', 'pms.operating_calendar.upsert', $2, $3,
       'in_progress', 'property', $4::uuid, $5::timestamptz,
       $5::timestamptz, $5::timestamptz + interval '24 hours'
     )`,
    [
      idempotencyId,
      `calendar-seed-${randomUUID()}`,
      `fingerprint-${randomUUID()}`,
      input.propertyId,
      ACCEPTED_AT.toISOString(),
    ],
  );
  await admin.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, occurred_at, tenant_scope,
       property_id, resource_product, resource_type, resource_id
     ) VALUES (
       $1::uuid, 'pms', $2, 'pms.operating_calendar.changed', $3::timestamptz,
       'property', $4::uuid, 'pms', 'operating_calendar', $4::uuid::text
     )`,
    [eventId, `calendar-seed-${randomUUID()}`, ACCEPTED_AT.toISOString(), input.propertyId],
  );
  await admin.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type, tenant_scope,
       property_id, resource_product, resource_type, resource_id
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'pms.inventory-source',
       'pms.operating_calendar.changed', 'property', $4::uuid,
       'pms', 'operating_calendar', $4::uuid::text
     )`,
    [outboxId, eventId, `calendar-seed-${randomUUID()}`, input.propertyId],
  );
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO pms.operating_calendar_revisions (
         organization_id, property_id, calendar_revision, contract_version,
         property_profile_revision, property_time_zone, schedule_mode,
         recurring_period_count, room_binding_count, default_minimum_stay_nights,
         idempotency_key_id, domain_event_id, outbox_event_id,
         created_by_user_id, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'pms-operating-calendar.v1', 1,
         'Europe/Berlin', 'year_round', 0, $9, 1, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::timestamptz, $8::timestamptz
       )`,
      [
        input.organizationId,
        input.propertyId,
        input.revision,
        idempotencyId,
        eventId,
        outboxId,
        input.actorUserId,
        ACCEPTED_AT.toISOString(),
        input.roomTypeIds?.length ?? 1 + (input.additionalRoomTypes?.length ?? 0),
      ],
    );
    for (const roomTypeId of input.roomTypeIds ?? [
      input.roomTypeId,
      ...(input.additionalRoomTypes ?? []),
    ]) {
      await admin.query(
        `INSERT INTO pms.operating_calendar_room_bindings (
         property_id, calendar_revision, room_type_id,
         source_room_facts_revision, source_room_units_revision,
         physical_capacity_count, starting_sellable_limit_count
       ) VALUES ($1::uuid, $2, $3::uuid, 1, 1, 2, $4)`,
        [input.propertyId, input.revision, roomTypeId, input.startingLimit],
      );
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function materializationCommand(
  fixture: Fixture,
  key: string,
  revision: number,
  from: string,
  through: string,
): PmsInventoryMaterializationCommand {
  const configuration = fixture.configurations.get(revision);
  if (!configuration) throw new Error("Missing test configuration");
  return {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    configurationSource: configuration.source,
    expectedMaterializedRevision: revision,
    horizon: { from, through },
    idempotencyKey: key,
    audit: {
      actor: { kind: "user", userId: fixture.actorUserId },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      requestedAt: ACCEPTED_AT.toISOString(),
    },
  };
}

async function consumeAndOverrideFirstDay(
  admin: Pick<pg.PoolClient, "query">,
  fixture: Fixture,
): Promise<void> {
  await admin.query(
    `UPDATE pms.inventory_days
     SET assigned_count = 2, available_count = 0,
         booking_source_revision = 1, inventory_revision = 2
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
  await admin.query(
    `UPDATE pms.inventory_days
     SET manual_sellable_limit_count = 1, effective_sellable_limit_count = 1,
         available_count = 0, manual_source_revision = 1, inventory_revision = 3
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
}

async function readFirstDay(admin: Pick<pg.PoolClient, "query">, fixture: Fixture) {
  const result = await admin.query<{
    calendarRevision: number;
    inventoryRevision: number;
    generatedLimit: number;
    generatedRevision: number;
    assignedCount: number;
    bookingRevision: number;
    manualLimit: number | null;
    manualRevision: number;
    linkedStopSell: boolean;
    linkedSourceRevision: number;
    availableCount: number;
  }>(
    `SELECT calendar_revision AS "calendarRevision",
            inventory_revision AS "inventoryRevision",
            generated_sellable_limit_count AS "generatedLimit",
            generated_source_revision AS "generatedRevision",
            assigned_count AS "assignedCount",
            booking_source_revision AS "bookingRevision",
            manual_sellable_limit_count AS "manualLimit",
            manual_source_revision AS "manualRevision",
            linked_stop_sell AS "linkedStopSell",
            linked_source_revision AS "linkedSourceRevision",
            available_count AS "availableCount"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
  if (!result.rows[0]) throw new Error("Missing test inventory day");
  return result.rows[0];
}

async function sideEffectCounts(admin: Pick<pg.PoolClient, "query">, propertyId: string) {
  const result = await admin.query<{
    audits: number;
    idempotency: number;
    events: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM platform.product_audit_events
        WHERE property_id = $1::uuid
          AND action = 'pms.inventory.materialize') AS audits,
       (SELECT count(*)::integer FROM platform.idempotency_keys
        WHERE property_id = $1::uuid
          AND operation = 'pms.inventory.materialize') AS idempotency,
       (SELECT count(*)::integer FROM platform.domain_events
        WHERE property_id = $1::uuid
          AND resource_type = 'inventory_materialization') AS events,
       (SELECT count(*)::integer FROM platform.outbox_events
        WHERE property_id = $1::uuid
          AND destination = 'distribution.inventory-projection') AS outbox`,
    [propertyId],
  );
  if (!result.rows[0]) throw new Error("Missing materialization side-effect counts");
  return result.rows[0];
}

async function inventoryDayCount(
  admin: Pick<pg.PoolClient, "query">,
  propertyId: string,
): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM pms.inventory_days WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0]?.count ?? -1;
}

async function backendProcessId(client: Pick<pg.PoolClient, "query">): Promise<number> {
  const result = await client.query<{ processId: number }>(
    `SELECT pg_backend_pid()::integer AS "processId"`,
  );
  const processId = result.rows[0]?.processId;
  if (!processId) throw new Error("Missing PostgreSQL backend process ID");
  return processId;
}

async function waitForLockWaiter(
  admin: Pick<pg.PoolClient, "query">,
  blockingProcessId: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await admin.query<{ waitingCount: number }>(
      `SELECT count(*)::integer AS "waitingCount"
       FROM pg_stat_activity activity
       WHERE $1::integer = ANY(pg_blocking_pids(activity.pid))`,
      [blockingProcessId],
    );
    if ((result.rows[0]?.waitingCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the shared PMS inventory advisory lock");
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const databaseName = url.pathname.slice(1);
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
