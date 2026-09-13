import {
  parsePricingConfiguration,
  pricingCurrencyScale,
  pricingInteger,
  pricingKeys,
  pricingObject,
  type PricingConfiguration,
} from "@vayada/domain-pms";
import type { PoolClient } from "pg";

export type PricingStorageSources = Readonly<Record<string, string>>;
export type PricingStorageSnapshot = Readonly<{
  currency: string;
  rooms: readonly PricingConfiguration[];
  ownerReferences: PricingStorageSources;
}>;
export type StoredPricingRevision = PricingStorageSnapshot &
  Readonly<{ revision: number; sources: PricingStorageSources }>;
export class PricingStorageError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "denied"
      | "stale"
      | "idempotency_conflict"
      | "currency_conversion_required",
  ) {
    super(code);
  }
}
const fail = (): never => {
  throw new PricingStorageError("invalid");
};
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim();
const references = (v: unknown): v is PricingStorageSources =>
  pricingObject(v) &&
  Object.keys(v).length > 0 &&
  Object.entries(v).every(([k, x]) => text(k) && text(x));
export function parsePricingStorageSnapshot(
  value: unknown,
  propertyId: string,
  revision: number,
): PricingStorageSnapshot {
  if (
    !pricingObject(value) ||
    !pricingKeys(value, ["currency", "rooms", "ownerReferences"]) ||
    typeof value.currency !== "string" ||
    pricingCurrencyScale(value.currency) === null ||
    !references(value.ownerReferences) ||
    !Array.isArray(value.rooms)
  )
    return fail();
  const rooms = Array.from(value.rooms, parsePricingConfiguration);
  if (
    rooms.some(
      (r) =>
        !r ||
        r.propertyId !== propertyId ||
        r.revision !== revision ||
        r.currency !== value.currency,
    ) ||
    new Set(rooms.map((r) => r!.roomTypeId)).size !== rooms.length
  )
    return fail();
  return structuredClone({
    currency: value.currency,
    rooms: rooms as PricingConfiguration[],
    ownerReferences: value.ownerReferences,
  });
}

/** Internal storage primitive, not authorization or owner freshness evidence.
 * Caller must authorize the property and hold its PMS inventory/publication lock
 * in the same transaction. Service composition must separately check current owners.
 */
export async function readCurrentPricingSnapshot(
  client: PoolClient,
  propertyId: string,
): Promise<StoredPricingRevision | null> {
  const row = (
    await client.query(
      `SELECT h.revision AS head_revision,r.revision,r.currency,r.source_revisions,r.owner_references,r.room_count
    FROM pms.pricing_v2_heads h LEFT JOIN pms.pricing_v2_revisions r USING(property_id,revision)
    WHERE h.property_id=$1`,
      [propertyId],
    )
  ).rows[0];
  if (!row || row.head_revision === 0) return null;
  if (
    !pricingInteger(row.revision, 1) ||
    row.revision > 2147483647 ||
    row.revision !== row.head_revision ||
    !pricingInteger(row.room_count) ||
    !references(row.source_revisions)
  )
    return fail();
  const records = (
    await client.query(
      `SELECT room_type_id,configuration FROM pms.pricing_v2_rooms
    WHERE property_id=$1 AND revision=$2 ORDER BY room_type_id`,
      [propertyId, row.revision],
    )
  ).rows;
  if (
    records.length !== row.room_count ||
    records.some(
      (r) => !pricingObject(r.configuration) || r.configuration.roomTypeId !== r.room_type_id,
    )
  )
    return fail();
  const parsed = parsePricingStorageSnapshot(
    {
      currency: row.currency,
      ownerReferences: row.owner_references,
      rooms: records.map((r) => r.configuration),
    },
    propertyId,
    row.revision,
  );
  return { ...parsed, revision: row.revision, sources: structuredClone(row.source_revisions) };
}
