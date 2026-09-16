import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type {
  PmsAcceptedPricingReservationCommand,
  PmsAcceptedPricingReservationPort,
} from "@vayada/domain-pms";
import { enqueueHostInventoryChanges } from "./pmsHostInventoryEffects.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { lockCurrentPmsPricingEntitlement } from "./replacementPricingAuthorization.js";

type ReceiptRow = {
  receiptId: string;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  quoteId: string;
  state: string;
  revision: number;
};
type AssignmentRow = {
  position: number;
  roomTypeId: string;
  status: string;
  source: string;
  evidence: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  payload: Record<string, unknown>;
};

export class PmsAcceptedPricingReservationConflict extends Error {
  constructor() {
    super("accepted_pricing_reservation_conflict");
    this.name = "PmsAcceptedPricingReservationConflict";
  }
}

/** Caller owns the transaction through job completion. This implementation
 * locks PMS scope and never reads Booking tables; migration0211 independently
 * verifies immutable Booking acceptance when assignments are inserted/updated. */
export function createPgPmsAcceptedPricingReservationPort(
  client: PoolClient,
): PmsAcceptedPricingReservationPort {
  return {
    async adoptAcceptedPricingReservation(command) {
      if (!validCommand(command)) throw conflict();
      await client.query("SAVEPOINT pms_accepted_pricing_reservation");
      try {
        await lockPmsInventoryMutationScope(client, command.propertyId);
        if (!(await ownsVayadaPms(client, command))) throw conflict();
        const receipts = await lockReceipts(client, command);
        const byType = receiptByType(command, receipts);
        if (!byType) throw conflict();
        const existing = await lockAssignments(client, command);
        const replayed = existing.length > 0;
        if (replayed) {
          if (!exactReplay(command, existing, byType, receipts)) throw conflict();
          await client.query(
            `UPDATE pms.operational_booking_assignments SET updated_at=updated_at
           WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
            [command.propertyId, command.guestBookingId],
          );
        } else {
          if (receipts.some(({ state, revision }) => state !== "reserved" || revision !== 1))
            throw conflict();
          await insertAssignments(client, command, byType);
        }
        await client.query(
          "SET CONSTRAINTS pms.trg_pms_direct_booking_inventory_receipt_handoff IMMEDIATE",
        );
        await client.query(
          "SET CONSTRAINTS pms.trg_pms_direct_booking_inventory_receipt_handoff DEFERRED",
        );
        if (replayed) {
          await client.query("RELEASE SAVEPOINT pms_accepted_pricing_reservation");
          return {
            outcome: "replayed",
            guestBookingId: command.guestBookingId,
            acceptanceId: command.acceptanceId,
          };
        }
        const spans = uniqueSpans(command);
        const operationalAt = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now"))
          .rows[0]?.now;
        if (!(operationalAt instanceof Date)) throw new Error("PMS database clock unavailable");
        const changedAt = operationalAt.toISOString();
        await reconcilePmsOccupiedInventory(client, command.propertyId, spans, changedAt);
        const linked = await reconcilePmsLinkedInventory(
          client,
          command.propertyId,
          changedAt,
          spans.map(({ roomTypeId, checkIn, checkOut }) => ({
            roomTypeId,
            startsOn: checkIn,
            endsOn: priorDate(checkOut),
          })),
        );
        await enqueuePmsLinkedInventorySideEffects(
          client,
          {
            propertyId: command.propertyId,
            operation: "accepted_pricing_reservation",
            commandId: command.acceptanceId,
            keyHash: command.pricingQuoteId,
            acceptedAt: changedAt,
            audit: { requestId: command.acceptanceId },
          },
          linked,
        );
        await enqueueHostInventoryChanges(
          client,
          {
            propertyId: command.propertyId,
            previewId: `pricing-acceptance:${command.acceptanceId}`,
            fingerprint: command.pricingQuoteId,
            occurredAt: operationalAt,
          },
          spans,
        );
        await client.query("RELEASE SAVEPOINT pms_accepted_pricing_reservation");
        return {
          outcome: "adopted",
          guestBookingId: command.guestBookingId,
          acceptanceId: command.acceptanceId,
        };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT pms_accepted_pricing_reservation");
        await client.query("RELEASE SAVEPOINT pms_accepted_pricing_reservation");
        if (
          isRecord(error) &&
          error["constraint"] === "chk_pms_direct_booking_receipt_handoff_scope"
        )
          throw conflict();
        throw error;
      }
    },
  };
}

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const date = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
function validCommand(command: PmsAcceptedPricingReservationCommand) {
  const selections = command.rooms.map(({ selectionId }) => selectionId);
  return (
    command.contractVersion === "pms-accepted-pricing-reservation.v1" &&
    [
      command.acceptanceId,
      command.pricingQuoteId,
      command.guestBookingId,
      command.propertyId,
      command.organizationId,
      ...command.inventoryReservation.receipts.map(({ receiptId }) => receiptId),
      ...command.rooms.map(({ roomTypeId }) => roomTypeId),
    ].every(uuid) &&
    Number.isFinite(Date.parse(command.acceptedAt)) &&
    new Date(command.acceptedAt).toISOString() === command.acceptedAt &&
    date(command.stay.checkIn) &&
    date(command.stay.checkOut) &&
    command.stay.checkIn < command.stay.checkOut &&
    command.inventoryReservation.contractVersion === "pms-inventory-reservation-bundle.v1" &&
    command.inventoryReservation.owner === "pms" &&
    command.inventoryReservation.receipts.length > 0 &&
    command.inventoryReservation.receipts.length <= 99 &&
    command.inventoryReservation.receipts.every(
      (receipt) =>
        receipt.contractVersion === "pms-inventory-reservation-lifecycle.v1" &&
        receipt.owner === "pms",
    ) &&
    new Set(command.inventoryReservation.receipts.map(({ receiptId }) => receiptId)).size ===
      command.inventoryReservation.receipts.length &&
    command.rooms.length > 0 &&
    command.rooms.length <= 99 &&
    new Set(selections).size === selections.length &&
    command.rooms.every(
      (room, index) =>
        room.position === index + 1 &&
        room.selectionId.length > 0 &&
        room.selectionId.length <= 200 &&
        room.offerId.length > 0 &&
        room.offerId.length <= 200 &&
        Number.isSafeInteger(room.adults) &&
        room.adults >= 1 &&
        room.childAgesAtCheckIn.every((age) => Number.isSafeInteger(age) && age >= 0 && age <= 17),
    )
  );
}

async function ownsVayadaPms(client: PoolClient, command: PmsAcceptedPricingReservationCommand) {
  const owner = await client.query(
    `SELECT organization.id FROM identity.organizations organization
     JOIN hotel_catalog.properties property ON property.id=$2::uuid
     WHERE organization.id=$1::uuid AND organization.kind='hotel_group'
       AND organization.status='active' AND property.profile_status<>'disabled'
       AND EXISTS(SELECT 1 FROM identity.organization_resource_links link
         WHERE link.organization_id=organization.id AND link.product='pms'
           AND link.resource_type='pms_property' AND link.resource_id=property.id::text
           AND link.status='active' AND link.relationship IN ('owner','operator'))
     FOR UPDATE OF organization`,
    [command.organizationId, command.propertyId],
  );
  return (
    owner.rows.length === 1 &&
    (await lockCurrentPmsPricingEntitlement(client, command.organizationId, command.propertyId))
  );
}

async function lockReceipts(client: PoolClient, command: PmsAcceptedPricingReservationCommand) {
  return (
    await client.query<ReceiptRow>(
      `SELECT receipt.receipt_id::text AS "receiptId",
       receipt.organization_id::text AS "organizationId",receipt.property_id::text AS "propertyId",
       receipt.room_type_id::text AS "roomTypeId",receipt.check_in::text AS "checkIn",
       receipt.check_out::text AS "checkOut",receipt.room_count AS "roomCount",
       receipt.quote_session_id AS "quoteId",status.lifecycle_state AS state,
       status.lifecycle_revision AS revision
       FROM pms.inventory_reservation_receipts receipt
       JOIN pms.inventory_reservation_statuses status USING(receipt_id)
       WHERE receipt.receipt_id=ANY($1::uuid[]) ORDER BY receipt.receipt_id FOR UPDATE OF status`,
      [command.inventoryReservation.receipts.map(({ receiptId }) => receiptId)],
    )
  ).rows;
}

function receiptByType(
  command: PmsAcceptedPricingReservationCommand,
  receipts: readonly ReceiptRow[],
) {
  if (receipts.length !== command.inventoryReservation.receipts.length) return null;
  const expected = new Map<string, number>();
  for (const room of command.rooms)
    expected.set(room.roomTypeId, (expected.get(room.roomTypeId) ?? 0) + 1);
  const byType = new Map<string, ReceiptRow>();
  for (const receipt of receipts) {
    if (
      receipt.organizationId !== command.organizationId ||
      receipt.propertyId !== command.propertyId ||
      receipt.quoteId !== command.pricingQuoteId ||
      receipt.checkIn !== command.stay.checkIn ||
      receipt.checkOut !== command.stay.checkOut ||
      receipt.roomCount !== expected.get(receipt.roomTypeId) ||
      byType.has(receipt.roomTypeId) ||
      !["reserved", "handed_off"].includes(receipt.state)
    )
      return null;
    byType.set(receipt.roomTypeId, receipt);
  }
  return byType.size === expected.size ? byType : null;
}

async function lockAssignments(client: PoolClient, command: PmsAcceptedPricingReservationCommand) {
  return (
    await client.query<AssignmentRow>(
      `SELECT position,room_type_id::text AS "roomTypeId",assignment_status AS status,
       source,stay_evidence_kind AS evidence,check_in::text AS "checkIn",
       check_out::text AS "checkOut",adults,children,assignment_payload AS payload
       FROM pms.operational_booking_assignments
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid ORDER BY position FOR UPDATE`,
      [command.propertyId, command.guestBookingId],
    )
  ).rows;
}

function exactReplay(
  command: PmsAcceptedPricingReservationCommand,
  existing: readonly AssignmentRow[],
  byType: ReadonlyMap<string, ReceiptRow>,
  receipts: readonly ReceiptRow[],
) {
  return (
    existing.length === command.rooms.length &&
    receipts.every(({ state, revision }) => state === "handed_off" && revision === 2) &&
    existing.every((assignment, index) => {
      const room = command.rooms[index]!,
        receipt = byType.get(room.roomTypeId)!;
      if (!isRecord(assignment.payload)) return false;
      return (
        assignment.position === room.position &&
        assignment.source === "direct_booking" &&
        assignment.evidence === "exact" &&
        !["canceled", "released"].includes(assignment.status) &&
        assignment.checkIn === command.stay.checkIn &&
        assignment.checkOut === command.stay.checkOut &&
        assignment.adults === room.adults &&
        assignment.children === room.childAgesAtCheckIn.length &&
        isDeepStrictEqual(assignment.payload.inventoryReservation, {
          contractVersion: "pms-inventory-reservation-lifecycle.v1",
          owner: "pms",
          receiptId: receipt.receiptId,
        }) &&
        isDeepStrictEqual(assignment.payload.pricingAcceptance, provenance(command, room))
      );
    })
  );
}

async function insertAssignments(
  client: PoolClient,
  command: PmsAcceptedPricingReservationCommand,
  byType: ReadonlyMap<string, ReceiptRow>,
) {
  const assignments = command.rooms.map((room) => ({
    ...room,
    children: room.childAgesAtCheckIn.length,
    payload: {
      contractVersion: command.contractVersion,
      inventoryReservation: {
        contractVersion: "pms-inventory-reservation-lifecycle.v1",
        owner: "pms",
        receiptId: byType.get(room.roomTypeId)!.receiptId,
      },
      pricingAcceptance: provenance(command, room),
    },
  }));
  await client.query(
    `INSERT INTO pms.operational_booking_assignments
     (property_id,guest_booking_id,room_type_id,position,assignment_status,source,
      stay_evidence_kind,check_in,check_out,adults,children,assignment_payload)
     SELECT $1::uuid,$2::uuid,item."roomTypeId"::uuid,item.position,'pending',
      'direct_booking','exact',$3::date,$4::date,item.adults,item.children,item.payload
     FROM jsonb_to_recordset($5::jsonb) item(
      "roomTypeId" text,position int,adults int,children int,payload jsonb)
     ORDER BY item.position`,
    [
      command.propertyId,
      command.guestBookingId,
      command.stay.checkIn,
      command.stay.checkOut,
      JSON.stringify(assignments),
    ],
  );
}

function provenance(
  command: PmsAcceptedPricingReservationCommand,
  room: PmsAcceptedPricingReservationCommand["rooms"][number],
) {
  return {
    acceptanceId: command.acceptanceId,
    selectionId: room.selectionId,
    offerId: room.offerId,
    childAgesAtCheckIn: room.childAgesAtCheckIn,
  };
}

function uniqueSpans(command: PmsAcceptedPricingReservationCommand) {
  return [
    ...new Map(
      command.rooms.map((room) => [
        room.roomTypeId,
        {
          roomTypeId: room.roomTypeId,
          checkIn: command.stay.checkIn,
          checkOut: command.stay.checkOut,
        },
      ]),
    ).values(),
  ];
}

const conflict = () => new PmsAcceptedPricingReservationConflict();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const priorDate = (value: string) =>
  new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
