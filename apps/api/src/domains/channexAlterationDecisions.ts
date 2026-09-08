import pg from "pg";
import { z } from "zod";
import type {
  createChannexRequestDecisions,
  ChannexRequestState,
} from "../integrations/channexRequestDecisions.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const inputSchema = z.object({
  propertyId: uuid,
  bookingId: uuid,
  changeRequestId: uuid,
  actorUserId: uuid,
  action: z.enum(["accept", "decline"]),
  correlationId: z.string().trim().min(1).max(200),
});
type Input = z.infer<typeof inputSchema>;
const bindingSchema = z.object({
  eventId: uuid,
  connectionId: uuid,
  bindingGeneration: uuid,
  providerPropertyId: uuid,
});
const journalSchema = z.object({
  action: z.enum(["accept", "decline"]),
  actorUserId: uuid,
  correlationId: z.string(),
  acceptedAt: z.iso.datetime(),
  sendStartedAt: z.iso.datetime().nullable(),
  providerState: z
    .enum(["pending", "accepted", "declined", "withdrawn", "resolved_unknown"])
    .nullable(),
  deliveryState: z.enum(["queued", "unknown", "resolved"]),
});
export type ChannexAlterationDecision = z.infer<typeof journalSchema>;
type Row = { status: string; changes: Record<string, unknown> };
type Provider = ReturnType<typeof createChannexRequestDecisions>;

/** Internal command; a route must enforce property authorization before calling.
 * No runtime registration. A separate journal pool prevents send-marker starvation.
 */
export async function decideChannexAlteration(
  config: {
    pool: pg.Pool;
    journalPool: pg.Pool;
    provider: Provider;
    assertAvailability: (
      transaction: pg.PoolClient,
      input: {
        propertyId: string;
        bookingId: string;
        changes: Record<string, unknown>;
      },
    ) => Promise<void>;
  },
  value: Input,
): Promise<ChannexAlterationDecision> {
  const input = inputSchema.parse(value);
  if (config.pool === config.journalPool)
    throw new Error("alteration_separate_journal_pool_required");
  const client = await config.pool.connect();
  const lockKey = `channex-alteration-decision:${input.changeRequestId}`;
  let locked = false;
  let inTransaction = false;
  let discard = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [lockKey],
    );
    if (!lock.rows[0]?.locked) throw new Error("alteration_decision_in_progress");
    locked = true;
    await client.query("BEGIN");
    inTransaction = true;
    const row = (
      await client.query<Row>(
        `SELECT change.status,change.requested_changes AS changes FROM booking.booking_change_requests change
       JOIN booking.guest_bookings booking ON booking.id=change.guest_booking_id
       WHERE change.id=$1::uuid AND booking.id=$2::uuid AND booking.property_id=$3::uuid
         AND change.request_type='date_change' FOR UPDATE OF change`,
        [input.changeRequestId, input.bookingId, input.propertyId],
      )
    ).rows[0];
    if (!row) throw new Error("alteration_not_found");
    const metadata = z.record(z.string(), z.unknown()).parse(row.changes["channex"]);
    const binding = bindingSchema.parse(metadata);
    let decision: ChannexAlterationDecision;
    if (metadata["decision"] !== undefined) {
      decision = journalSchema.parse(metadata["decision"]);
      if (decision.action !== input.action) throw new Error("alteration_decision_conflict");
    } else {
      if (row.status !== "pending") throw new Error("alteration_not_pending");
      decision = {
        action: input.action,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        acceptedAt: new Date().toISOString(),
        sendStartedAt: null,
        providerState: null,
        deliveryState: "queued",
      };
      await save(client, input, decision);
    }
    await client.query("COMMIT");
    inTransaction = false;
    if (decision.deliveryState === "resolved") return decision;

    await client.query("BEGIN");
    inTransaction = true;
    if (!decision.sendStartedAt && input.action === "accept")
      await lockPmsInventoryMutationScope(client, input.propertyId);
    const owned = await client.query<{
      checkIn: string;
      checkOut: string;
      total: string;
      adults: number;
      children: number;
      currency: string;
    }>(
      `SELECT booking.check_in::text AS "checkIn", booking.check_out::text AS "checkOut",
         booking.total_amount::text AS total, booking.adults, booking.children, booking.currency
       FROM pms.channel_connections connection
       JOIN pms.channel_binding_claims claim ON claim.property_id=connection.property_id
         AND claim.provider='channex' AND claim.external_property_id=connection.external_property_id
         AND claim.claim_state='active'
       JOIN booking.guest_bookings booking ON booking.property_id=connection.property_id
       WHERE connection.id=$1::uuid AND connection.property_id=$2::uuid
         AND connection.provider='channex' AND connection.connection_status='connected'
         AND connection.external_property_id=$3 AND connection.binding_generation=$4::uuid
         AND booking.id=$5::uuid AND booking.booking_channel='airbnb'
         AND ($6::boolean OR booking.lifecycle_status='confirmed')
       FOR SHARE OF connection,claim FOR UPDATE OF booking`,
      [
        binding.connectionId,
        input.propertyId,
        binding.providerPropertyId,
        binding.bindingGeneration,
        input.bookingId,
        Boolean(decision.sendStartedAt),
      ],
    );
    if (owned.rows.length !== 1) throw new Error("alteration_connection_or_booking_changed");
    const proposal = z.object({ providerBookingId: uuid }).parse(row.changes);
    const mappings = await client.query<{ bookingId: string }>(
      `SELECT guest_booking_id::text AS "bookingId" FROM pms.channel_booking_mappings
       WHERE connection_id=$1::uuid AND property_id=$2::uuid AND external_booking_id=$3
         AND sync_status='active' FOR SHARE`,
      [binding.connectionId, input.propertyId, proposal.providerBookingId],
    );
    if (
      !mappings.rows.length ||
      mappings.rows.some((mapping) => mapping.bookingId !== input.bookingId)
    )
      throw new Error("alteration_booking_mapping_changed");
    const providerScope = {
      eventId: binding.eventId,
      providerPropertyId: binding.providerPropertyId,
      kind: "alteration_request" as const,
    };
    if (!decision.sendStartedAt) {
      const current = await config.provider.read(providerScope);
      if (!current.ok) throw new Error("alteration_provider_read_failed");
      if (current.state !== "pending") {
        decision = outcome(decision, current.state);
        await save(client, input, decision);
        await client.query("COMMIT");
        inTransaction = false;
        return decision;
      }
      const booking = owned.rows[0]!;
      if (
        input.action === "accept" &&
        (row.changes["oldCheckIn"] !== booking.checkIn ||
          row.changes["oldCheckOut"] !== booking.checkOut ||
          row.changes["oldTotal"] !== booking.total ||
          row.changes["oldAdults"] !== booking.adults ||
          row.changes["oldChildren"] !== booking.children ||
          row.changes["currency"] !== booking.currency)
      )
        throw new Error("alteration_booking_snapshot_changed");
      if (input.action === "accept")
        await config.assertAvailability(client, {
          propertyId: input.propertyId,
          bookingId: input.bookingId,
          changes: row.changes,
        });
      // Committed independently while this transaction fences binding and inventory.
      decision = { ...decision, sendStartedAt: new Date().toISOString(), deliveryState: "unknown" };
      await save(config.journalPool, input, decision);
      const result = await config.provider.resolve(providerScope, { action: input.action });
      if (result.ok) decision = outcome(decision, result.state);
    } else {
      const result = await config.provider.read(providerScope);
      if (result.ok) decision = outcome(decision, result.state);
    }
    await save(client, input, decision);
    await client.query("COMMIT");
    inTransaction = false;
    return decision;
  } finally {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (locked && !discard) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]);
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}
function outcome(
  decision: ChannexAlterationDecision,
  state: ChannexRequestState,
): ChannexAlterationDecision {
  return {
    ...decision,
    providerState: state,
    deliveryState: state === "pending" ? "unknown" : "resolved",
  };
}
async function save(
  client: Pick<pg.Pool, "query">,
  input: Input,
  decision: ChannexAlterationDecision,
) {
  const result = await client.query(
    `UPDATE booking.booking_change_requests change
     SET requested_changes=jsonb_set(requested_changes,'{channex,decision}',$4::jsonb),updated_at=now()
     FROM booking.guest_bookings booking WHERE change.guest_booking_id=booking.id
       AND change.id=$1::uuid AND booking.id=$2::uuid AND booking.property_id=$3::uuid`,
    [input.changeRequestId, input.bookingId, input.propertyId, JSON.stringify(decision)],
  );
  if (result.rowCount !== 1) throw new Error("alteration_decision_not_saved");
}
