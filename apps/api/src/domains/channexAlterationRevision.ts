import { z } from "zod";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { assertChannexAlterationAvailability } from "./channexAlterationAvailability.js";
import {
  reconcilePmsOccupiedInventory,
  type PmsOccupiedInventoryClient,
} from "./pmsOccupiedInventory.js";

const uuid = z.uuid();
const money = z.string().regex(/^\d{1,13}(?:\.\d{1,2})?$/);
const room = z.object({
  room_type_id: uuid,
  occupancy: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0).default(0),
  }),
});
const revisionSchema = z.object({
  id: z.string().min(1),
  booking_id: uuid,
  property_id: uuid,
  status: z.literal("modified"),
  arrival_date: z.iso.date(),
  departure_date: z.iso.date(),
  currency: z.string(),
  amount: money,
  rooms: z.array(room).min(1).max(100),
});
type Scope = {
  propertyId: string;
  bookingId: string;
  connectionId: string;
  bindingGeneration: string;
  providerPropertyId: string;
};

/** Caller owns the booking-import transaction, inventory lock and connected binding lock. */
export async function applyChannexAlterationRevision(
  client: PmsOccupiedInventoryClient,
  scope: Scope,
  value: unknown,
): Promise<boolean> {
  const requests = await client.query<{ id: string }>(
    `SELECT id FROM booking.booking_change_requests
     WHERE guest_booking_id=$1 AND status='pending' AND requested_changes ? 'channex'`,
    [scope.bookingId],
  );
  if (!requests.rows.length) return false;
  if (requests.rows.length !== 1) throw new Error("alteration_revision_ambiguous");
  await lockPmsInventoryMutationScope(client, scope.propertyId);
  const binding = await client.query(
    `SELECT connection.id FROM pms.channel_connections connection
    JOIN pms.channel_binding_claims claim ON claim.property_id=connection.property_id AND claim.provider='channex'
      AND claim.external_property_id=connection.external_property_id AND claim.claim_state='active'
    WHERE connection.id=$1 AND connection.property_id=$2 AND connection.external_property_id=$3
      AND connection.binding_generation=$4 AND connection.provider='channex' AND connection.connection_status='connected'
    FOR SHARE OF connection,claim`,
    [scope.connectionId, scope.propertyId, scope.providerPropertyId, scope.bindingGeneration],
  );
  if (binding.rowCount !== 1) throw new Error("alteration_revision_binding_changed");
  const request = requests.rows[0]!;
  const lock = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
    [`channex-alteration-decision:${request.id}`],
  );
  if (!lock.rows[0]?.locked) throw new Error("alteration_revision_decision_in_progress");
  const current = (
    await client.query<{ changes: Record<string, unknown> }>(
      "SELECT requested_changes AS changes FROM booking.booking_change_requests WHERE id=$1 AND status='pending' FOR UPDATE",
      [request.id],
    )
  ).rows[0];
  if (!current) return false;
  const changes = current.changes;
  const metadata = z
    .object({
      connectionId: uuid,
      bindingGeneration: uuid,
      providerPropertyId: uuid,
      providerState: z.string().optional(),
      decision: z.object({ providerState: z.string().nullable() }).optional(),
    })
    .parse(changes["channex"]);
  if (
    metadata.connectionId !== scope.connectionId ||
    metadata.bindingGeneration !== scope.bindingGeneration ||
    metadata.providerPropertyId !== scope.providerPropertyId
  )
    throw new Error("alteration_revision_binding_changed");
  const state =
    metadata.providerState && metadata.providerState !== "pending"
      ? metadata.providerState
      : metadata.decision?.providerState;
  if (state !== "accepted") throw new Error("alteration_revision_acceptance_unconfirmed");
  const envelope = z.record(z.string(), z.unknown()).parse(value);
  const attributes = envelope["attributes"]
    ? z.record(z.string(), z.unknown()).parse(envelope["attributes"])
    : envelope;
  const revision = revisionSchema.parse({ ...attributes, id: envelope["id"] ?? attributes["id"] });
  const proposedTotal = money.nullable().parse(changes["newTotal"]);
  const proposedRooms = z
    .array(z.object({ roomTypeId: uuid, adults: z.number(), children: z.number() }))
    .parse(changes["rooms"]);
  if (
    revision.booking_id !== changes["providerBookingId"] ||
    revision.property_id !== scope.providerPropertyId ||
    revision.arrival_date !== changes["requestedCheckIn"] ||
    revision.departure_date !== changes["requestedCheckOut"] ||
    revision.currency !== changes["currency"] ||
    (proposedTotal !== null && Number(revision.amount) !== Number(proposedTotal)) ||
    revision.rooms.length !== proposedRooms.length ||
    revision.rooms.some(
      (item, index) =>
        item.room_type_id !== proposedRooms[index]!.roomTypeId ||
        item.occupancy.adults !== proposedRooms[index]!.adults ||
        item.occupancy.children !== proposedRooms[index]!.children,
    )
  )
    throw new Error("alteration_revision_proposal_mismatch");
  const booking = (
    await client.query<{
      checkIn: string;
      checkOut: string;
      total: string;
      adults: number;
      children: number;
      roomCount: number;
      currency: string;
    }>(
      `SELECT check_in::text AS "checkIn",check_out::text AS "checkOut",total_amount::text AS total,
       adults,children,room_count AS "roomCount",currency FROM booking.guest_bookings
     WHERE id=$1 AND property_id=$2 AND booking_channel='airbnb' AND lifecycle_status='confirmed' FOR UPDATE`,
      [scope.bookingId, scope.propertyId],
    )
  ).rows[0];
  if (
    !booking ||
    booking.checkIn !== changes["oldCheckIn"] ||
    booking.checkOut !== changes["oldCheckOut"] ||
    booking.total !== changes["oldTotal"] ||
    booking.adults !== changes["oldAdults"] ||
    booking.children !== changes["oldChildren"] ||
    booking.currency !== revision.currency
  )
    throw new Error("alteration_revision_original_changed");
  const assignments = await client.query<{
    id: string;
    position: number;
    roomTypeId: string;
    source: string;
    releasedByAlteration: boolean;
    roomId: string | null;
    status: string;
    version: string | null;
  }>(
    `SELECT assignment.id,assignment.position,assignment.room_type_id AS "roomTypeId",assignment.room_id AS "roomId",
       assignment.assignment_status AS status,assignment.assignment_payload->>'version' AS version,assignment.source,
       assignment.assignment_payload @> '{"channexAlterationReleased":true}'::jsonb AS "releasedByAlteration"
     FROM pms.operational_booking_assignments assignment
     WHERE assignment.property_id=$1 AND assignment.guest_booking_id=$2
       ORDER BY assignment.position FOR UPDATE OF assignment`,
    [scope.propertyId, scope.bookingId],
  );
  const active = assignments.rows.filter((item) => !["released", "canceled"].includes(item.status));
  if (
    active.length !== booking.roomCount ||
    active.some(
      (item, index) =>
        item.position !== index + 1 || !["pending", "assigned"].includes(item.status),
    ) ||
    assignments.rows.some(
      (item) =>
        item.position <= revision.rooms.length &&
        !active.includes(item) &&
        !(item.status === "released" && item.source === "channel" && item.releasedByAlteration),
    )
  )
    throw new Error("alteration_revision_assignment_unsupported");
  const mappings = await client.query<{ externalId: string; roomTypeId: string }>(
    `SELECT external_room_type_id AS "externalId",room_type_id AS "roomTypeId"
     FROM pms.channel_room_type_mappings WHERE property_id=$1 AND connection_id=$2
       AND status='active' AND external_room_type_id=ANY($3::text[]) FOR SHARE`,
    [scope.propertyId, scope.connectionId, revision.rooms.map((item) => item.room_type_id)],
  );
  const desired = revision.rooms.map((item, index) => {
    const matches = mappings.rows.filter((mapping) => mapping.externalId === item.room_type_id);
    if (matches.length !== 1) throw new Error("alteration_room_mapping_unavailable");
    const assignment = assignments.rows.find((row) => row.position === index + 1);
    return {
      roomTypeId: matches[0]!.roomTypeId,
      occupancy: item.occupancy,
      assignment,
      retain:
        !!assignment &&
        active.includes(assignment) &&
        assignment.roomTypeId === matches[0]!.roomTypeId,
    };
  });
  await assertChannexAlterationAvailability(client, {
    propertyId: scope.propertyId,
    bookingId: scope.bookingId,
    changes,
  });
  const physicalConflict = await client.query(
    `SELECT 1 FROM pms.operational_booking_assignments other JOIN booking.guest_bookings other_booking
       ON other_booking.id=other.guest_booking_id AND other_booking.property_id=other.property_id WHERE other.property_id=$1
       AND other.guest_booking_id<>$2 AND other.room_id=ANY($3::uuid[])
       AND other.assignment_status NOT IN ('released','canceled')
       AND COALESCE(other.check_in,other_booking.check_in)<$5::date AND COALESCE(other.check_out,other_booking.check_out)>$4::date
     UNION ALL SELECT 1 FROM pms.room_blocks block WHERE block.property_id=$1 AND block.room_id=ANY($3::uuid[])
       AND block.status='active' AND block.starts_on<$5::date AND block.ends_on>=$4::date LIMIT 1`,
    [
      scope.propertyId,
      scope.bookingId,
      desired
        .filter((item) => item.retain)
        .map((item) => item.assignment!.roomId)
        .filter(Boolean),
      revision.arrival_date,
      revision.departure_date,
    ],
  );
  if (physicalConflict.rows.length) throw new Error("alteration_revision_physical_room_conflict");
  const updatedAt = new Date().toISOString();
  const versions = assignments.rows.map((item) => {
    const prior = /^reservation-v(\d+)$/.exec(item.version ?? "");
    return prior ? BigInt(prior[1]!) : 0n;
  });
  const version = `reservation-v${versions.reduce((max, value) => (value > max ? value : max), 0n) + 1n}`;
  for (const assignment of active.filter((item) => item.position > desired.length)) {
    await client.query(
      `UPDATE pms.operational_booking_assignments SET assignment_status='released',
       assignment_payload=assignment_payload || $2::jsonb,updated_at=$3 WHERE id=$1`,
      [
        assignment.id,
        JSON.stringify({
          channexRevisionId: revision.id,
          channexAlterationReleased: true,
          version,
        }),
        updatedAt,
      ],
    );
  }
  for (const [index, item] of desired.entries()) {
    const payload = JSON.stringify({
      channexRevisionId: revision.id,
      version,
    });
    if (item.assignment) {
      await client.query(
        `UPDATE pms.operational_booking_assignments SET room_type_id=$2,check_in=$3,check_out=$4,adults=$5,children=$6,
         room_id=CASE WHEN $7 THEN room_id ELSE NULL END,rate_plan_id=CASE WHEN $7 THEN rate_plan_id ELSE NULL END,
         assigned_at=CASE WHEN $7 THEN assigned_at ELSE NULL END,
         assignment_status=CASE WHEN $7 THEN assignment_status ELSE 'pending' END,stay_evidence_kind='exact',
         assignment_payload=(assignment_payload - 'channexAlterationReleased') || $8::jsonb,updated_at=$9 WHERE id=$1`,
        [
          item.assignment.id,
          item.roomTypeId,
          revision.arrival_date,
          revision.departure_date,
          item.occupancy.adults,
          item.occupancy.children,
          item.retain,
          payload,
          updatedAt,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,position,
         source,channel,external_reservation_id,check_in,check_out,stay_evidence_kind,adults,children,assignment_payload,updated_at)
         VALUES($1,$2,$3,$4,'channel','airbnb',$5,$6,$7,'exact',$8,$9,$10::jsonb,$11)`,
        [
          scope.propertyId,
          scope.bookingId,
          item.roomTypeId,
          index + 1,
          revision.booking_id,
          revision.arrival_date,
          revision.departure_date,
          item.occupancy.adults,
          item.occupancy.children,
          payload,
          updatedAt,
        ],
      );
    }
  }
  await client.query(
    `UPDATE booking.guest_bookings SET check_in=$3,check_out=$4,adults=$5,children=$6,total_amount=$7::numeric,
    balance_amount=CASE WHEN payment_status='unpaid' THEN $7::numeric ELSE balance_amount END,updated_at=$8,room_count=$9 WHERE id=$1 AND property_id=$2`,
    [
      scope.bookingId,
      scope.propertyId,
      revision.arrival_date,
      revision.departure_date,
      revision.rooms.reduce((n, item) => n + item.occupancy.adults, 0),
      revision.rooms.reduce((n, item) => n + item.occupancy.children, 0),
      revision.amount,
      updatedAt,
      desired.length,
    ],
  );
  await reconcilePmsOccupiedInventory(
    client,
    scope.propertyId,
    [
      ...active.map((item) => ({
        roomTypeId: item.roomTypeId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      })),
      ...desired.map((item) => ({
        roomTypeId: item.roomTypeId,
        checkIn: revision.arrival_date,
        checkOut: revision.departure_date,
      })),
    ],
    updatedAt,
  );
  await client.query(
    `UPDATE booking.booking_change_requests SET status='accepted',decided_at=now(),
    requested_changes=jsonb_set(requested_changes,'{channex,appliedRevisionId}',to_jsonb($2::text)),updated_at=now() WHERE id=$1`,
    [request.id, revision.id],
  );
  const from = [booking.checkIn, revision.arrival_date].sort()[0]!;
  const to = new Date(
    Date.parse([booking.checkOut, revision.departure_date].sort()[1]!) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  for (const roomTypeId of new Set([...active, ...desired].map((item) => item.roomTypeId))) {
    const key = `channex.alteration.applied:${request.id}:${revision.id}:${roomTypeId}`;
    const payload = JSON.stringify({
      propertyId: scope.propertyId,
      roomTypeId,
      dateRange: { from, to },
      inventoryVersion: key,
      triggerRefId: request.id,
    });
    await client.query(
      `WITH event AS (
      INSERT INTO platform.domain_events(source_system,event_key,event_type,occurred_at,tenant_scope,property_id,
        resource_product,resource_type,resource_id,correlation_id,payload)
      VALUES('pms',$1,'pms.inventory.changed',$2,'property',$3,'pms','room_type',$4,$5,$6::jsonb)
      RETURNING id
    ) INSERT INTO platform.outbox_events(domain_event_id,outbox_key,destination,event_type,tenant_scope,
        property_id,resource_product,resource_type,resource_id,correlation_id,payload)
      SELECT event.id,$1 || output.suffix,output.destination,output.event_type,'property',$3,'pms','room_type',$4,$5,$6::jsonb
      FROM event CROSS JOIN (VALUES
        ('.ari','pms.channel-manager','pms.inventory.ari_changed'),
        ('.distribution','distribution.public-bookability','pms.inventory.changed'),
        ('.calendar','pms.calendar-projection','pms.calendar.refresh_requested')
      ) output(suffix,destination,event_type)`,
      [key, updatedAt, scope.propertyId, roomTypeId, request.id, payload],
    );
  }
  return true;
}
