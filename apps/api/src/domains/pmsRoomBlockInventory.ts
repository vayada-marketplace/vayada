import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";

/** Recounts a room type's blocked rooms per night from its active blocks. */
export async function reconcileRoomBlockInventory(
  client: DistributionBookingPublicationTransaction,
  propertyId: string,
  roomTypeId: string,
  affectedFrom: string,
  affectedTo: string,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `WITH affected_dates AS (
       SELECT generate_series($3::date, $4::date, interval '1 day')::date AS stay_date
     ), changes AS (
       SELECT affected.stay_date,
              COALESCE(SUM(block.blocked_count), 0)::integer AS blocked_count
       FROM affected_dates affected
       LEFT JOIN pms.room_blocks block
         ON block.property_id = $1::uuid AND block.room_type_id = $2::uuid
        AND block.status = 'active'
        AND affected.stay_date BETWEEN block.starts_on AND block.ends_on
       GROUP BY affected.stay_date
     )
     UPDATE pms.inventory_days inventory
     SET blocked_count = changes.blocked_count,
         available_count = CASE WHEN inventory.status = 'closed' OR inventory.linked_stop_sell
           THEN 0 ELSE GREATEST(
           0, COALESCE(inventory.effective_sellable_limit_count, inventory.total_count)
             - inventory.assigned_count - changes.blocked_count
         ) END,
         inventory_revision = CASE WHEN inventory.inventory_revision IS NULL THEN NULL ELSE inventory.inventory_revision + 1 END,
         block_source_revision = CASE WHEN inventory.block_source_revision IS NULL THEN NULL ELSE inventory.block_source_revision + 1 END,
         updated_at = $5::timestamptz
     FROM changes
     WHERE inventory.property_id = $1::uuid AND inventory.room_type_id = $2::uuid
       AND inventory.stay_date = changes.stay_date
       AND inventory.blocked_count IS DISTINCT FROM changes.blocked_count`,
    [propertyId, roomTypeId, affectedFrom, affectedTo, acceptedAt],
  );
}
