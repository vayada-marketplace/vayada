import pg from "pg";
import { z } from "zod";
import type { createChannexRequestDecisions } from "../integrations/channexRequestDecisions.js";

const bindingSchema = z.object({
  eventId: z.uuid(),
  connectionId: z.uuid(),
  bindingGeneration: z.uuid(),
  providerPropertyId: z.uuid(),
});
type Options = {
  pool: pg.Pool;
  provider: Pick<ReturnType<typeof createChannexRequestDecisions>, "read">;
  ownsMutation: () => boolean;
  signal?: AbortSignal;
  limit?: number;
};

/** Dormant until intake and authoritative revision application are ready. GET only. */
export async function runChannexAlterationReadback(options: Options) {
  const counts = { refreshed: 0, deferred: 0, skipped: 0 };
  const active = () => !options.signal?.aborted && options.ownsMutation();
  if (!active()) return counts;
  const candidates = await options.pool.query<{ id: string }>(
    `SELECT id FROM booking.booking_change_requests
     WHERE status='pending' AND request_type='date_change' AND requested_changes ? 'channex'
       AND COALESCE(requested_changes #>> '{channex,readback,nextCheckAt}','') <= $1
     ORDER BY COALESCE(requested_changes #>> '{channex,readback,nextCheckAt}',''),created_at,id
     LIMIT $2`,
    [
      new Date().toISOString(),
      z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(options.limit ?? 25),
    ],
  );
  for (const { id } of candidates.rows) {
    if (!active()) break;
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [`channex-alteration-decision:${id}`],
      );
      if (!lock.rows[0]?.locked) {
        counts.skipped++;
        continue;
      }
      const row = (
        await client.query<{
          bookingId: string;
          propertyId: string;
          changes: Record<string, unknown>;
        }>(
          `SELECT change.guest_booking_id AS "bookingId",booking.property_id AS "propertyId",
           change.requested_changes AS changes
         FROM booking.booking_change_requests change
         JOIN booking.guest_bookings booking ON booking.id=change.guest_booking_id
         WHERE change.id=$1 AND change.status='pending'
           AND COALESCE(change.requested_changes #>> '{channex,readback,nextCheckAt}','') <= $2`,
          [id, new Date().toISOString()],
        )
      ).rows[0];
      if (!row) {
        counts.skipped++;
        continue;
      }
      let failure: string | null = null;
      let state: string | null = null;
      const metadata =
        z.record(z.string(), z.unknown()).safeParse(row.changes["channex"]).data ?? {};
      const binding = bindingSchema.safeParse(metadata);
      const providerBookingId = z.uuid().safeParse(row.changes["providerBookingId"]);
      if (!binding.success || !providerBookingId.success) failure = "invalid_binding";
      else {
        const owned = await client.query(
          `SELECT booking.id FROM pms.channel_connections connection
           JOIN pms.channel_binding_claims claim ON claim.property_id=connection.property_id
             AND claim.provider='channex' AND claim.external_property_id=connection.external_property_id
             AND claim.claim_state='active'
           JOIN booking.guest_bookings booking ON booking.property_id=connection.property_id
           WHERE connection.id=$1 AND connection.property_id=$2 AND connection.provider='channex'
             AND connection.connection_status='connected' AND connection.external_property_id=$3
             AND connection.binding_generation=$4 AND booking.id=$5 AND booking.booking_channel='airbnb'
           FOR SHARE OF connection,claim,booking`,
          [
            binding.data.connectionId,
            row.propertyId,
            binding.data.providerPropertyId,
            binding.data.bindingGeneration,
            row.bookingId,
          ],
        );
        const mappings =
          owned.rowCount === 1
            ? await client.query<{ bookingId: string }>(
                `SELECT guest_booking_id AS "bookingId" FROM pms.channel_booking_mappings
           WHERE connection_id=$1 AND property_id=$2 AND external_booking_id=$3
             AND sync_status='active' FOR SHARE`,
                [binding.data.connectionId, row.propertyId, providerBookingId.data],
              )
            : null;
        if (
          !mappings?.rows.length ||
          mappings.rows.some((item) => item.bookingId !== row.bookingId)
        )
          failure = "binding_or_mapping_changed";
        else {
          if (!active()) break;
          try {
            const result = await options.provider.read({
              eventId: binding.data.eventId,
              providerPropertyId: binding.data.providerPropertyId,
              kind: "alteration_request",
            });
            if (result.ok) state = result.state;
            else failure = result.failure;
          } catch {
            failure = "provider_read_failed";
          }
        }
      }
      if (!active()) break;
      const decision = z.record(z.string(), z.unknown()).safeParse(metadata["decision"]).data;
      const observed = metadata["providerState"];
      const previous = observed && observed !== "pending" ? observed : decision?.["providerState"];
      const clarifiesUnknown =
        previous === "resolved_unknown" &&
        (state === "accepted" || state === "declined" || state === "withdrawn");
      if (state && previous && previous !== "pending" && state !== previous && !clarifiesUnknown) {
        state = null;
        failure = "provider_resolution_conflict";
      }
      if (state) {
        metadata["providerState"] = state;
        if (decision)
          metadata["decision"] = {
            ...decision,
            providerState: state,
            deliveryState: state === "pending" ? decision["deliveryState"] : "resolved",
          };
      }
      metadata["readback"] = {
        checkedAt: new Date().toISOString(),
        failure,
        nextCheckAt: new Date(Date.now() + (failure ? 15 : 5) * 60_000).toISOString(),
      };
      const status =
        state === "declined" ? "declined" : state === "withdrawn" ? "canceled" : "pending";
      await client.query(
        `UPDATE booking.booking_change_requests SET requested_changes=jsonb_set(requested_changes,'{channex}',$2::jsonb),
           status=$3,decided_at=CASE WHEN $3 <> 'pending' THEN COALESCE(decided_at,now()) ELSE decided_at END,
           updated_at=now() WHERE id=$1 AND status='pending'`,
        [id, JSON.stringify(metadata), status],
      );
      if (!active()) break;
      await client.query("COMMIT");
      counts[failure ? "deferred" : "refreshed"]++;
    } finally {
      // Also releases the transaction advisory lock on skipped/aborted work.
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
  return counts;
}
