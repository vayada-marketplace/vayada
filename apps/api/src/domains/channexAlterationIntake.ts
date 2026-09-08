import pg from "pg";
import { z } from "zod";

const money = z.string().regex(/^\d{1,13}(?:\.\d{1,2})?$/);
const count = z.number().int().min(0).max(100);
const scopeSchema = z.object({
  propertyId: z.uuid(),
  connectionId: z.uuid(),
  bindingGeneration: z.uuid(),
  providerPropertyId: z.uuid(),
  eventId: z.uuid(),
});
export type ChannexAlterationScope = z.infer<typeof scopeSchema>;
const eventSchema = z.object({
  data: z.object({
    id: z.uuid(),
    attributes: z.object({
      id: z.uuid().optional(),
      property_id: z.uuid(),
      event: z.literal("alteration_request"),
      payload: z.object({
        resolved: z.boolean(),
        status: z.string().optional(),
        bms: z.object({
          booking_id: z.uuid(),
          property_id: z.uuid(),
          arrival_date: z.iso.date(),
          departure_date: z.iso.date(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: money.nullish(),
          rooms: z
            .array(
              z.object({
                room_type_id: z.uuid(),
                occupancy: z.object({ adults: count, children: count.default(0) }),
              }),
            )
            .min(1)
            .max(100),
        }),
      }),
    }),
  }),
});

/** Call only with a freshly pulled provider event, not an unchecked webhook. */
export async function persistChannexAlteration(
  pool: pg.Pool,
  expected: ChannexAlterationScope,
  value: unknown,
): Promise<{ requestId: string; replayed: boolean }> {
  const scope = scopeSchema.safeParse(expected),
    event = eventSchema.safeParse(value);
  if (!scope.success || !event.success) throw new Error("invalid_alteration_payload");
  const { id, attributes } = event.data.data,
    { bms, resolved } = attributes.payload;
  if (
    id !== expected.eventId ||
    (attributes.id && attributes.id !== id) ||
    attributes.property_id !== expected.providerPropertyId ||
    bms.property_id !== expected.providerPropertyId
  ) {
    throw new Error("alteration_scope_mismatch");
  }
  if (bms.arrival_date >= bms.departure_date) throw new Error("invalid_alteration_dates");
  const adults = bms.rooms.reduce((n, room) => n + room.occupancy.adults, 0);
  const children = bms.rooms.reduce((n, room) => n + room.occupancy.children, 0);
  if (adults < 1 || adults > 100 || children > 100) throw new Error("invalid_alteration_occupancy");
  const proposal = {
    providerBookingId: bms.booking_id,
    requestedCheckIn: bms.arrival_date,
    requestedCheckOut: bms.departure_date,
    requestedAdults: adults,
    requestedChildren: children,
    currency: bms.currency,
    newTotal: bms.amount == null ? null : decimal(bms.amount),
    rooms: bms.rooms.map((room) => ({ roomTypeId: room.room_type_id, ...room.occupancy })),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const binding = await client.query(
      `SELECT connection.id FROM pms.channel_connections connection
       JOIN pms.channel_binding_claims claim ON claim.property_id=connection.property_id
         AND claim.provider='channex' AND claim.external_property_id=connection.external_property_id
         AND claim.claim_state='active'
       WHERE connection.id=$1::uuid AND connection.property_id=$2::uuid
         AND connection.provider='channex' AND connection.connection_status='connected'
         AND connection.external_property_id=$3 AND connection.binding_generation=$4::uuid
       FOR SHARE OF connection, claim`,
      [
        expected.connectionId,
        expected.propertyId,
        expected.providerPropertyId,
        expected.bindingGeneration,
      ],
    );
    if (binding.rows.length !== 1) throw new Error("alteration_connection_not_owned");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `channex-alteration:${id}`,
    ]);
    const mapped = await client.query<{ bookingId: string }>(
      `SELECT guest_booking_id::text AS "bookingId" FROM pms.channel_booking_mappings
       WHERE connection_id=$1::uuid AND property_id=$2::uuid AND external_booking_id=$3
         AND sync_status='active' FOR SHARE`,
      [expected.connectionId, expected.propertyId, bms.booking_id],
    );
    if (new Set(mapped.rows.map((row) => row.bookingId)).size !== 1)
      throw new Error("alteration_booking_not_mapped");
    const roomIds = [...new Set(bms.rooms.map((room) => room.room_type_id))];
    const rooms = await client.query(
      `SELECT mapping.id FROM pms.channel_room_type_mappings mapping
       JOIN pms.room_types room ON room.id=mapping.room_type_id AND room.property_id=mapping.property_id
       WHERE mapping.connection_id=$1::uuid AND mapping.property_id=$2::uuid
         AND mapping.external_room_type_id=ANY($3::text[]) AND mapping.status='active' AND room.active
       FOR SHARE OF mapping, room`,
      [expected.connectionId, expected.propertyId, roomIds],
    );
    if (rooms.rows.length !== roomIds.length) throw new Error("alteration_room_not_mapped");
    const bookingId = mapped.rows[0]!.bookingId;
    const booking = (
      await client.query<{
        checkIn: string;
        checkOut: string;
        total: string;
        adults: number;
        children: number;
        currency: string;
      }>(
        `SELECT check_in::text AS "checkIn",check_out::text AS "checkOut",total_amount::text AS total,adults,children,currency
       FROM booking.guest_bookings WHERE id=$1::uuid AND property_id=$2::uuid
         AND booking_channel='airbnb' AND lifecycle_status='confirmed' FOR UPDATE`,
        [bookingId, expected.propertyId],
      )
    ).rows[0];
    if (!booking) throw new Error("alteration_booking_not_confirmed_airbnb");
    if (booking.currency !== bms.currency) throw new Error("alteration_currency_mismatch");
    const existing = (
      await client.query<{ id: string; bookingId: string; matches: boolean }>(
        `SELECT id::text,guest_booking_id::text AS "bookingId",
       (requested_changes->'channex'->'proposal'=$2::jsonb
         AND requested_changes->'channex'->>'connectionId'=$3
         AND requested_changes->'channex'->>'bindingGeneration'=$4) AS matches
       FROM booking.booking_change_requests WHERE requested_changes->'channex'->>'eventId'=$1 FOR UPDATE`,
        [id, JSON.stringify(proposal), expected.connectionId, expected.bindingGeneration],
      )
    ).rows[0];
    if (existing) {
      if (existing.bookingId !== bookingId || !existing.matches)
        throw new Error("alteration_identity_conflict");
      await client.query("COMMIT");
      return { requestId: existing.id, replayed: true };
    }
    // Terminal events belong to reconciliation, never a newly actionable request.
    if (resolved) throw new Error("alteration_already_resolved");
    const active = await client.query(
      `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1::uuid
         AND (status='pending' OR (status='accepted' AND requested_changes ? 'channex'
         AND requested_changes->'channex'->>'appliedRevisionId' IS NULL))`,
      [bookingId],
    );
    if (active.rows.length) throw new Error("alteration_request_conflict");
    const result = await client.query<{ id: string }>(
      `INSERT INTO booking.booking_change_requests(guest_booking_id,request_type,requested_by,requested_changes)
       VALUES($1::uuid,'date_change','guest',$2::jsonb) RETURNING id::text`,
      [
        bookingId,
        JSON.stringify({
          oldCheckIn: booking.checkIn,
          oldCheckOut: booking.checkOut,
          oldTotal: booking.total,
          oldAdults: booking.adults,
          oldChildren: booking.children,
          ...proposal,
          priceDifference:
            proposal.newTotal === null ? null : decimalDifference(proposal.newTotal, booking.total),
          channex: {
            eventId: id,
            connectionId: expected.connectionId,
            bindingGeneration: expected.bindingGeneration,
            providerPropertyId: expected.providerPropertyId,
            proposal,
          },
        }),
      ],
    );
    await client.query("COMMIT");
    return { requestId: result.rows[0]!.id, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function decimal(value: string): string {
  return decimalFromCents(cents(value));
}
function decimalDifference(a: string, b: string): string {
  return decimalFromCents(cents(a) - cents(b));
}
function decimalFromCents(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}
