import { randomUUID } from "node:crypto";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

/** Booking Admin › Settings › Room Sorting (VAY-2449): booking_settings.room_sorting (0534). Whether guests
 * can sort the rooms, whether the menu hides for a single room, the options in the menu's order and the
 * default one. NULL is the defaults below. */

export const ROOM_SORT_KEYS = [
  "recommended",
  "priceLow",
  "priceHigh",
  "roomSize",
  "capacity",
  "bestDeal",
] as const;
export type RoomSortKey = (typeof ROOM_SORT_KEYS)[number];

export type RoomSorting = {
  enabled: boolean;
  hideWithOneRoom: boolean;
  /** Every option once, in the guest menu's order; `enabled` shows it to guests. */
  options: { key: RoomSortKey; enabled: boolean }[];
  /** An enabled option. */
  defaultOption: RoomSortKey;
};

/** Every hotel until it saves its own: today's four options, Recommended first and default. */
export const DEFAULT_ROOM_SORTING: RoomSorting = {
  enabled: true,
  hideWithOneRoom: true,
  options: ROOM_SORT_KEYS.map((key) => ({
    key,
    enabled: key !== "capacity" && key !== "bestDeal",
  })),
  defaultOption: "recommended",
};

/** What guests get with the room catalogue: the menu's options in order (only those shown). */
export type GuestRoomSorting = {
  enabled: boolean;
  hideWithOneRoom: boolean;
  options: RoomSortKey[];
  defaultOption: RoomSortKey;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isSortKey = (value: unknown): value is RoomSortKey =>
  ROOM_SORT_KEYS.includes(value as RoomSortKey);

/** A saved or submitted Room Sorting, or null. Every option exactly once, at least one shown, and the
 * default one of those shown. */
export function parseRoomSorting(value: unknown): RoomSorting | null {
  if (
    !isRecord(value) ||
    !hasExactly(value, ["enabled", "hideWithOneRoom", "options", "defaultOption"])
  )
    return null;
  const { enabled, hideWithOneRoom, options, defaultOption } = value;
  if (typeof enabled !== "boolean" || typeof hideWithOneRoom !== "boolean") return null;
  if (!Array.isArray(options) || options.length !== ROOM_SORT_KEYS.length) return null;
  const parsed: RoomSorting["options"] = [];
  for (const option of options) {
    if (!isRecord(option) || !hasExactly(option, ["key", "enabled"])) return null;
    if (!isSortKey(option.key) || typeof option.enabled !== "boolean") return null;
    if (parsed.some(({ key }) => key === option.key)) return null;
    parsed.push({ key: option.key, enabled: option.enabled });
  }
  if (!parsed.some((option) => option.enabled)) return null;
  if (!parsed.some((option) => option.key === defaultOption && option.enabled)) return null;
  return { enabled, hideWithOneRoom, options: parsed, defaultOption: defaultOption as RoomSortKey };
}

export function guestRoomSorting(sorting: RoomSorting): GuestRoomSorting {
  return {
    enabled: sorting.enabled,
    hideWithOneRoom: sorting.hideWithOneRoom,
    options: sorting.options.filter((option) => option.enabled).map((option) => option.key),
    defaultOption: sorting.defaultOption,
  };
}

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

/** The hotel's own Room Sorting for guests, read live; null while it uses the defaults (nothing saved, or
 * a saved value that no longer reads). */
export async function readGuestRoomSorting(
  db: Queryable,
  propertyId: string,
): Promise<GuestRoomSorting | null> {
  const result = await db.query<{ sorting: unknown }>(
    "SELECT room_sorting AS sorting FROM booking.booking_settings WHERE property_id = $1::uuid",
    [propertyId],
  );
  const sorting = parseRoomSorting(result.rows[0]?.sorting ?? null);
  return sorting ? guestRoomSorting(sorting) : null;
}

export type RoomSortingSummary = {
  sorting: RoomSorting;
  defaults: RoomSorting;
  /** False until the hotel has booking settings; nothing can be saved yet. */
  canSave: boolean;
};

export type RoomSortingUpdate = {
  propertyId: string;
  sorting: RoomSorting;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type BookingRoomSortingRepository = {
  /** Null when the property doesn't exist. */
  read(propertyId: string): Promise<RoomSortingSummary | null>;
  /** Null when the property has no booking settings to save into. */
  save(command: RoomSortingUpdate): Promise<RoomSorting | null>;
  close?(): Promise<void>;
};

// Saving deliberately leaves booking_settings.updated_at alone: the booking page publication hashes that row,
// and a guest-side setting read live must not make a live page look edited (as VAY-2200 and VAY-2126).
export function createPgBookingRoomSortingRepository(config: {
  connectionString: string;
  max?: number;
}): BookingRoomSortingRepository {
  if (!config.connectionString.trim())
    throw new Error("Booking room sorting repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async read(propertyId) {
      const result = await pool.query<{ hasSettings: boolean; sorting: unknown }>(
        `SELECT settings.property_id IS NOT NULL AS "hasSettings", settings.room_sorting AS sorting
         FROM hotel_catalog.properties property
         LEFT JOIN booking.booking_settings settings ON settings.property_id = property.id
         WHERE property.id = $1::uuid`,
        [propertyId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        sorting: parseRoomSorting(row.sorting) ?? DEFAULT_ROOM_SORTING,
        defaults: DEFAULT_ROOM_SORTING,
        canSave: row.hasSettings,
      };
    },

    async save({ propertyId, sorting, audit }) {
      const result = await pool.query<{ sorting: unknown }>(
        `WITH updated AS (
           UPDATE booking.booking_settings SET room_sorting = $2::jsonb
           WHERE property_id = $1::uuid
           RETURNING room_sorting AS sorting
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           SELECT $3, 'booking', 'booking.room_sorting.updated', now(), 'property', NULL, $1::uuid, 'user',
             $4::uuid, 'booking', 'booking_hotel', $1::uuid::text, $5, $6, $2::jsonb,
             jsonb_build_object('organizationId', $7::uuid), 'internal'
           FROM updated
           RETURNING occurred_at
         )
         SELECT updated.sorting FROM updated CROSS JOIN audited`,
        [
          propertyId,
          JSON.stringify(sorting),
          `booking.room-sorting:${propertyId}:${randomUUID()}`,
          audit.actorUserId,
          audit.correlationId ?? audit.requestId,
          audit.requestId,
          audit.organizationId,
        ],
      );
      const row = result.rows[0];
      return row ? parseRoomSorting(row.sorting) : null;
    },

    async close() {
      await pool.end();
    },
  };
}
