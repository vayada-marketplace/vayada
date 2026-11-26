import {
  CHANNEL_MANAGER_VIEW_CONTRACT_VERSION,
  type ChannelManagerChannels,
  type ChannelManagerProblem,
  type ChannelManagerRoom,
  type ChannelManagerSync,
  type ChannelManagerView,
} from "@vayada/domain-pms-channex";
import type pg from "pg";

import { listChannexAlerts } from "./channexOperationalAlerts.js";
import { CHANNEX_ARI_MAPPING_MISSING_SQL } from "./pmsChannexAriMapping.js";

type Pool = Pick<pg.Pool, "query">;

/** The Channex connection a channel read needs: only a connected hotel is read from Channex. */
export type ChannelManagerConnection = Readonly<{ externalPropertyId: string }>;

/** VAY-2606: reads Booking.com and Airbnb (and their markups) from Channex, GET only. */
export type ChannelManagerChannelReader = (
  connection: ChannelManagerConnection,
) => Promise<ChannelManagerChannels>;

const CONNECTED = new Set(["connected", "degraded"]);
/** The booking pull runs every five minutes; half an hour without a good run means it isn't working. */
const PULL_STALE_MS = 30 * 60_000;
/** A problem marked as seen that hasn't happened again for a week leaves the page. */
const SEEN_QUIET_MS = 7 * 24 * 60 * 60_000;
const UNAVAILABLE: ChannelManagerChannels = { status: "unavailable" };

/**
 * VAY-2606: the Channel manager page, read-only. The rooms are the published offers on the current Channex
 * connection (what Booking.com and Airbnb actually sell), not the old system's rate plan mappings; new bookings
 * come from the booking pull's own runs, which never write the sync status table.
 */
export async function readChannelManagerView(
  pool: Pool,
  propertyId: string,
  options: { now?: Date; readChannels?: ChannelManagerChannelReader } = {},
): Promise<ChannelManagerView> {
  const now = (options.now ?? new Date()).toISOString();
  const connection = (
    await pool.query<{
      status: ChannelManagerView["connection"]["status"];
      externalPropertyId: string | null;
      ariMappingMissing: boolean;
    }>(
      `SELECT connection.connection_status AS status,
              connection.external_property_id AS "externalPropertyId",
              EXISTS (
                SELECT 1 FROM pms.inventory_days inventory
                WHERE inventory.property_id = connection.property_id
                  AND inventory.stay_date >= ($2::timestamptz AT TIME ZONE COALESCE(location.timezone, 'UTC'))::date
                  AND ${CHANNEX_ARI_MAPPING_MISSING_SQL}
              ) AS "ariMappingMissing"
       FROM pms.channel_connections connection
       LEFT JOIN hotel_catalog.property_locations location ON location.property_id = connection.property_id
       WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'`,
      [propertyId, now],
    )
  ).rows[0];
  const status = connection?.status ?? "disconnected";
  const empty: ChannelManagerView = {
    contractVersion: CHANNEL_MANAGER_VIEW_CONTRACT_VERSION,
    propertyId,
    connection: { status },
    channels: UNAVAILABLE,
    rooms: [],
    sync: {
      prices: { status: "never", lastSuccessAt: null, retryAt: null },
      bookings: { status: "never", lastCheckedAt: null, latest: null },
    },
    problems: [],
  };
  if (!connection || !CONNECTED.has(status)) return empty;

  const [rooms, prices, pulls, latest, alerts, roomNames, channels] = await Promise.all([
    readRooms(pool, propertyId, now),
    pool.query<{
      status: string;
      lastSuccessAt: Date | string | null;
      retryAfter: Date | string | null;
      errorCode: string | null;
    }>(
      `SELECT sync.status, sync.last_success_at AS "lastSuccessAt", sync.retry_after AS "retryAfter",
              sync.last_error_code AS "errorCode"
       FROM pms.channel_sync_status sync
       JOIN pms.channel_connections connection
         ON connection.id = sync.connection_id AND connection.property_id = sync.property_id
        AND connection.provider = 'channex'
       WHERE sync.property_id = $1::uuid AND sync.sync_domain = 'ari'`,
      [propertyId],
    ),
    // The pull never retries in place: the next five-minute window pulls again (channexFeedPull.ts).
    pool.query<{ lastCheckedAt: Date | string | null; lastFailedAt: Date | string | null }>(
      `SELECT max(finished_at) FILTER (WHERE status = 'succeeded') AS "lastCheckedAt",
              max(finished_at) FILTER (WHERE status IN ('failed', 'dead_lettered')) AS "lastFailedAt"
       FROM platform.jobs
       WHERE queue_name = 'pms.channex.webhooks' AND job_type = 'channex.pull-booking-feed'
         AND property_id = $1::uuid`,
      [propertyId],
    ),
    pool.query<{
      channel: string;
      roomTypeName: string | null;
      checkIn: string;
      checkOut: string;
    }>(
      `SELECT booking.booking_channel AS channel, booking.check_in::text AS "checkIn",
              booking.check_out::text AS "checkOut",
              (SELECT room.name FROM pms.operational_booking_assignments assignment
                 JOIN pms.room_types room
                   ON room.id = assignment.room_type_id AND room.property_id = assignment.property_id
                WHERE assignment.property_id = booking.property_id
                  AND assignment.guest_booking_id = booking.id
                ORDER BY assignment.position LIMIT 1) AS "roomTypeName"
       FROM booking.guest_bookings booking
       WHERE booking.property_id = $1::uuid AND booking.source_system = 'pms'
         AND booking.booking_metadata ->> 'provider' = 'channex'
       ORDER BY booking.created_at DESC, booking.id DESC LIMIT 1`,
      [propertyId],
    ),
    listChannexAlerts(pool, propertyId),
    // Webhook alerts name Channex's room type; the hotel knows its own room.
    pool.query<{ externalRoomTypeId: string; name: string }>(
      `SELECT DISTINCT ON (mapping.external_room_type_id)
              mapping.external_room_type_id AS "externalRoomTypeId", room.name
       FROM pms.channel_room_type_mappings mapping
       JOIN pms.channel_connections connection
         ON connection.id = mapping.connection_id AND connection.property_id = mapping.property_id
        AND connection.provider = 'channex'
       JOIN pms.room_types room ON room.id = mapping.room_type_id AND room.property_id = mapping.property_id
       WHERE mapping.property_id = $1::uuid
       ORDER BY mapping.external_room_type_id, (mapping.status = 'active') DESC`,
      [propertyId],
    ),
    connection.externalPropertyId && options.readChannels
      ? options
          .readChannels({ externalPropertyId: connection.externalPropertyId })
          .catch(() => UNAVAILABLE)
      : Promise.resolve(UNAVAILABLE),
  ]);

  const names = new Map(roomNames.rows.map((row) => [row.externalRoomTypeId, row.name]));
  return {
    ...empty,
    channels,
    rooms,
    sync: {
      prices: priceSync(prices.rows[0], connection.ariMappingMissing, now),
      bookings: bookingSync(pulls.rows[0], latest.rows[0] ?? null, now),
    },
    problems: alerts
      .filter(
        (alert) =>
          !alert.resolvedAt &&
          !(
            alert.acknowledgedAt &&
            Date.parse(iso(alert.lastOccurredAt)!) < Date.parse(now) - SEEN_QUIET_MS
          ),
      )
      .map((alert): ChannelManagerProblem => {
        const impact = alert.impact;
        return {
          id: alert.id,
          eventType: alert.eventType,
          channel: impact.channel ?? null,
          roomTypeName:
            impact.roomTypeNames ??
            (impact.roomTypeId ? (names.get(impact.roomTypeId) ?? null) : null),
          dateFrom: impact.dateFrom ?? null,
          dateTo: impact.dateTo ?? null,
          reference: impact.reference ?? null,
          errorType: impact.errorType ?? null,
          firstOccurredAt: iso(alert.firstOccurredAt)!,
          acknowledgedAt: iso(alert.acknowledgedAt),
        };
      }),
  };
}

async function readRooms(pool: Pool, propertyId: string, now: string) {
  // The same offer the ARI sync sends: an active version on the current binding, for an active, open room.
  const result = await pool.query<{
    targetId: string;
    roomTypeId: string;
    roomTypeName: string;
    mealPlan: string | null;
    maxGuests: number | null;
    salesOpen: boolean;
    hasOpenNight: boolean;
  }>(
    `SELECT target.id::text AS "targetId", target.room_type_id::text AS "roomTypeId",
            room.name AS "roomTypeName", version.configuration ->> 'meal_type' AS "mealPlan",
            (SELECT max((option ->> 'occupancy')::int)
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(version.configuration -> 'options') = 'array'
                      THEN version.configuration -> 'options' ELSE '[]'::jsonb END) option
              WHERE jsonb_typeof(option -> 'occupancy') = 'number') AS "maxGuests",
            target.sales_state = 'open' AS "salesOpen",
            EXISTS (
              SELECT 1 FROM pms.inventory_days inventory
              WHERE inventory.property_id = target.property_id
                AND inventory.room_type_id = target.room_type_id
                AND inventory.status <> 'closed'
                AND inventory.stay_date >= ($2::timestamptz AT TIME ZONE COALESCE(location.timezone, 'UTC'))::date
                AND inventory.stay_date < ($2::timestamptz AT TIME ZONE COALESCE(location.timezone, 'UTC'))::date + 365
            ) AS "hasOpenNight"
     FROM pms.channex_offer_targets target
     JOIN pms.channel_connections connection
       ON connection.id = target.connection_id AND connection.property_id = target.property_id
      AND connection.provider = 'channex'
     JOIN pms.channex_offer_target_versions version
       ON version.target_id = target.id AND version.version = target.active_version
      AND version.binding_generation = connection.binding_generation
      AND version.external_property_id = connection.external_property_id
     JOIN pms.room_types room
       ON room.id = target.room_type_id AND room.property_id = target.property_id AND room.active
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = target.property_id
     WHERE target.property_id = $1::uuid
       AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closure
         WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id)
     ORDER BY room.sort_order, room.name, target.offer_id`,
    [propertyId, now],
  );
  return result.rows.map(
    (row): ChannelManagerRoom => ({
      targetId: row.targetId,
      roomTypeId: row.roomTypeId,
      roomTypeName: row.roomTypeName,
      mealPlan: row.mealPlan,
      maxGuests: row.maxGuests,
      selling: row.salesOpen && row.hasOpenNight,
      notSellingReason: !row.salesOpen
        ? "sales_closed"
        : row.hasOpenNight
          ? null
          : "no_open_nights",
    }),
  );
}

function priceSync(
  row:
    | {
        status: string;
        lastSuccessAt: Date | string | null;
        retryAfter: Date | string | null;
        errorCode: string | null;
      }
    | undefined,
  mappingMissing: boolean,
  now: string,
): ChannelManagerSync["prices"] {
  const lastSuccessAt = iso(row?.lastSuccessAt ?? null);
  // A missing room or rate mapping stops future nights from syncing, whatever the last run said.
  if (mappingMissing) return { status: "failed", lastSuccessAt, retryAt: null };
  if (!row) return { status: "never", lastSuccessAt: null, retryAt: null };
  // A good run that left some rooms' offers behind marks the status degraded (VAY-2108 D3).
  if (row.status === "degraded" && row.errorCode === "offer_targets_skipped")
    return { status: "partial", lastSuccessAt, retryAt: null };
  if (row.status === "failed" || row.status === "degraded") {
    const retryAt = iso(row.retryAfter);
    return retryAt && retryAt > now
      ? { status: "retrying", lastSuccessAt, retryAt }
      : { status: "failed", lastSuccessAt, retryAt: null };
  }
  return { status: lastSuccessAt ? "ok" : "never", lastSuccessAt, retryAt: null };
}

function bookingSync(
  row: { lastCheckedAt: Date | string | null; lastFailedAt: Date | string | null } | undefined,
  latest: ChannelManagerSync["bookings"]["latest"],
  now: string,
): ChannelManagerSync["bookings"] {
  const lastCheckedAt = iso(row?.lastCheckedAt ?? null);
  const lastFailedAt = iso(row?.lastFailedAt ?? null);
  // Finished pull runs are kept two days (channexFeedPull.ts), so a pull that stopped longer ago reads "never".
  if (!lastCheckedAt && !lastFailedAt) return { status: "never", lastCheckedAt, latest };
  const fresh =
    lastCheckedAt !== null && Date.parse(now) - Date.parse(lastCheckedAt) < PULL_STALE_MS;
  const status = !fresh
    ? "failed"
    : lastFailedAt && lastFailedAt > lastCheckedAt!
      ? "retrying"
      : "ok";
  return { status, lastCheckedAt, latest };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
