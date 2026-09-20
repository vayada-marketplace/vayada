import type { QueryResult, QueryResultRow } from "pg";

import type { PmsOccupiedInventoryChange } from "./pmsOccupiedInventory.js";

type Client = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

type Context = Readonly<{
  propertyId: string;
  reason: string;
  commandId: string;
  keyHash: string;
  acceptedAt: string;
  correlationId: string;
}>;

export async function enqueuePmsOccupiedInventoryAriChanges(
  client: Client,
  context: Context,
  changes: readonly PmsOccupiedInventoryChange[],
): Promise<void> {
  for (const range of collapseOccupiedInventoryChanges(changes)) {
    const coverageThroughExclusive = nextDate(range.through);
    const eventKey =
      `pms.occupied-inventory.changed.property.${context.propertyId}` +
      `.room.${range.roomTypeId}.${range.from}.${coverageThroughExclusive}` +
      `.reason.${context.reason}.command.${context.commandId}.key.${context.keyHash}.v1`;
    const payload = JSON.stringify({
      propertyId: context.propertyId,
      roomTypeId: range.roomTypeId,
      coverageFrom: range.from,
      coverageThroughExclusive,
      reason: context.reason,
      inventoryVersion: context.keyHash,
      triggerRefId: context.commandId,
    });
    const event = await client.query<{ eventId: string }>(
      `WITH inserted AS (
         INSERT INTO platform.domain_events (
           source_system,event_key,event_type,event_version,occurred_at,tenant_scope,
           property_id,resource_product,resource_type,resource_id,correlation_id,
           causation_id,idempotency_key_hash,payload,event_metadata
         ) VALUES ('pms',$1,'pms.inventory.changed',1,$2::timestamptz,'property',
           $3::uuid,'pms','room_type',$4::uuid,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT (source_system,event_key) DO NOTHING RETURNING id::text AS "eventId"
       ) SELECT "eventId" FROM inserted UNION ALL
       SELECT id::text FROM platform.domain_events
       WHERE source_system='pms' AND event_key=$1 LIMIT 1`,
      [
        eventKey,
        context.acceptedAt,
        context.propertyId,
        range.roomTypeId,
        context.correlationId,
        context.commandId,
        context.keyHash,
        payload,
        JSON.stringify({ contractVersion: "pms-occupied-inventory-ari.v1" }),
      ],
    );
    const eventId = event.rows[0]?.eventId;
    if (!eventId) throw new Error("Occupied inventory event could not be persisted");
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,
         idempotency_key_hash,payload,outbox_metadata
       ) VALUES ($1::uuid,$2,'pms.channel-manager','pms.inventory.ari_changed',
         'property',$3::uuid,'pms','room_type',$4::uuid,$5,$6,$7::jsonb,$8::jsonb)
       ON CONFLICT (destination,outbox_key) DO NOTHING`,
      [
        eventId,
        `${eventKey}.ari`,
        context.propertyId,
        range.roomTypeId,
        context.correlationId,
        context.keyHash,
        payload,
        JSON.stringify({ contractVersion: "pms-occupied-inventory-ari.v1" }),
      ],
    );
  }
}

export function collapseOccupiedInventoryChanges(changes: readonly PmsOccupiedInventoryChange[]) {
  const days = [
    ...new Map(changes.map((day) => [`${day.roomTypeId}:${day.stayDate}`, day])).values(),
  ].sort((left, right) =>
    left.roomTypeId === right.roomTypeId
      ? left.stayDate < right.stayDate
        ? -1
        : left.stayDate > right.stayDate
          ? 1
          : 0
      : left.roomTypeId < right.roomTypeId
        ? -1
        : 1,
  );
  const ranges: Array<{ roomTypeId: string; from: string; through: string }> = [];
  for (const day of days) {
    const previous = ranges.at(-1);
    if (previous?.roomTypeId === day.roomTypeId && nextDate(previous.through) === day.stayDate)
      previous.through = day.stayDate;
    else ranges.push({ roomTypeId: day.roomTypeId, from: day.stayDate, through: day.stayDate });
  }
  return ranges;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}
