import { randomUUID } from "node:crypto";

import type {
  PmsInventoryPublicOfferProjectionPort,
  PmsInventoryPublicOfferProjectionResult,
} from "@vayada/domain-distribution";
import { pricingCurrencyScale, projectReplacementRoomNights } from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  PricingStorageError,
  readCurrentPricingSnapshot,
  type StoredPricingRevision,
} from "./replacementPricingSnapshot.js";

type ProjectionClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

type ProjectionPool = {
  connect(): Promise<ProjectionClient>;
  end(): Promise<void>;
};

export type TargetPmsInventoryPublicOfferProjectionOptions = {
  connectionString: string;
  max?: number;
  pool?: ProjectionPool;
  now?: () => Date;
  random?: () => number;
  leaseDurationMs?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  refreshPublicBookability?: (command: { propertyId: string }) => Promise<void>;
};

type ClaimedEventRow = {
  outboxEventId: string;
  propertyId: string;
  attemptsCount: number;
  maxAttempts: number;
};

type FailedEventRow = {
  outboxEventId: string;
  attemptsCount: number;
  maxAttempts: number;
};

type ProjectionClaim = {
  propertyId: string;
  eventIds: string[];
  nextAttemptNumber: number;
  leaseToken: string;
  workerId: string;
};

type ProjectionClaimFailure = {
  failedEvents: number;
  exhaustedEvents: number;
};

type ProjectionLeaseRecovery = ProjectionClaimFailure;

export type PmsInventoryPublicOfferRetryBatchOptions = {
  workerId?: string;
  propertyLimit?: number;
};

export type PmsInventoryPublicOfferRetryBatchResult = {
  processedProperties: number;
  claimedEvents: number;
  publishedEvents: number;
  deferredEvents: number;
  failedEvents: number;
  exhaustedEvents: number;
  projectedOfferDays: number;
};

export interface TargetPmsInventoryPublicOfferProjection extends PmsInventoryPublicOfferProjectionPort {
  runRetryBatch(
    options?: PmsInventoryPublicOfferRetryBatchOptions,
  ): Promise<PmsInventoryPublicOfferRetryBatchResult>;
}

type InventoryDayRow = {
  roomTypeId: string;
  stayDate: string;
  availableCount: number;
  totalCount: number;
  open: boolean;
};

type PricedOfferDay = {
  roomTypeId: string;
  stayDate: string;
  key: string;
  status: "available" | "limited" | "sold_out" | "closed";
  availableRooms: number;
  price: string;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  mealPlan: string;
  minStay: number | null;
  maxStay: number | null;
};

const DEFAULT_PROJECTION_LEASE_DURATION_MS = 60_000;
const DEFAULT_PROJECTION_RETRY_DELAY_MS = 30_000;
const DEFAULT_PROJECTION_MAX_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_PROJECTION_RETRY_PROPERTY_LIMIT = 25;

const PUBLIC_OFFER_PROJECTION_EVENT_FILTER = `(
  (
    outbox.destination = 'distribution.public-bookability'
    AND outbox.event_type IN (
      'pms.inventory.changed', 'booking.same_day_booking_policy.changed'
    )
  )
  OR (
    outbox.destination = 'distribution.inventory-projection'
    AND outbox.event_type = 'pms.inventory.projection_refresh_requested'
  )
)`;

const CLAIM_PENDING_INVENTORY_EVENTS = `
  WITH candidate_event AS (
    SELECT outbox.id, outbox.property_id
    FROM platform.outbox_events outbox
    WHERE ${PUBLIC_OFFER_PROJECTION_EVENT_FILTER}
      AND outbox.tenant_scope = 'property'
      AND ($2::uuid IS NULL OR outbox.property_id = $2::uuid)
      AND outbox.attempts_count < outbox.max_attempts
      AND (
        (outbox.status = 'pending' AND ($6::boolean OR outbox.available_at <= $1::timestamptz))
        OR (outbox.status = 'failed' AND outbox.available_at <= $1::timestamptz)
      )
    ORDER BY outbox.priority DESC, outbox.available_at, outbox.created_at, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimable AS (
    SELECT outbox.id
    FROM platform.outbox_events outbox
    JOIN candidate_event candidate ON candidate.property_id = outbox.property_id
    WHERE ${PUBLIC_OFFER_PROJECTION_EVENT_FILTER}
      AND outbox.tenant_scope = 'property'
      AND outbox.attempts_count < outbox.max_attempts
      AND (
        (outbox.status = 'pending' AND ($6::boolean OR outbox.available_at <= $1::timestamptz))
        OR (outbox.status = 'failed' AND outbox.available_at <= $1::timestamptz)
      )
    FOR UPDATE OF outbox SKIP LOCKED
  )
  UPDATE platform.outbox_events outbox
  SET status = 'leased',
      attempts_count = outbox.attempts_count + 1,
      leased_until = $3::timestamptz,
      updated_at = $1::timestamptz,
      outbox_metadata = jsonb_set(
        outbox.outbox_metadata,
        '{publicOfferProjection}',
        COALESCE(outbox.outbox_metadata -> 'publicOfferProjection', '{}'::jsonb)
          || jsonb_build_object(
            'workerId', $4::text,
            'leaseToken', $5::text,
            'claimedAt', $1::text,
            'leaseExpiresAt', $3::text
          ),
        true
      )
  FROM claimable
  WHERE outbox.id = claimable.id
  RETURNING
    outbox.id::text AS "outboxEventId",
    outbox.property_id::text AS "propertyId",
    outbox.attempts_count AS "attemptsCount",
    outbox.max_attempts AS "maxAttempts"
`;

const READ_PUBLIC_OFFER_INVENTORY_DAYS = `
  SELECT
    inventory.room_type_id::text AS "roomTypeId",
    to_char(inventory.stay_date, 'YYYY-MM-DD') AS "stayDate",
    inventory.available_count AS "availableCount",
    inventory.total_count AS "totalCount",
    room.active AND inventory.status <> 'closed' AND COALESCE(inventory.rate_gate_open, TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM pms.room_type_closures closure
        WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
      ) AS "open"
  FROM pms.inventory_days inventory
  JOIN pms.room_types room ON room.property_id = inventory.property_id AND room.id = inventory.room_type_id
  JOIN distribution.public_hotel_bookability_profiles profile
    ON profile.property_id = inventory.property_id
  WHERE inventory.property_id = $1::uuid
    AND inventory.stay_date >= ($2::timestamptz AT TIME ZONE profile.timezone)::date
  ORDER BY inventory.room_type_id, inventory.stay_date
`;

/** Rows identical to the projection are filtered out first, so they are neither written nor
 * locked: a hotel has a row per room, offer and night, and most refreshes change a few. */
export const UPSERT_PRICED_PUBLIC_OFFERS = `
  WITH day AS (
    SELECT
      input.room_type_id,
      input.stay_date,
      input.offer_key,
      input.status,
      input.status IN ('available', 'limited') AS sellable,
      input.available_rooms,
      input.price,
      jsonb_build_object(
        'maxAdults', input.max_adults,
        'maxChildren', input.max_children,
        'maxOccupancy', input.max_occupancy
      ) AS occupancy,
      jsonb_strip_nulls(jsonb_build_object(
        'mealPlan', input.meal_plan,
        'minStayNights', input.min_stay,
        'maxStayNights', input.max_stay
      )) AS rate_summary,
      CASE input.status
        WHEN 'closed' THEN ARRAY['unpublished']
        WHEN 'sold_out' THEN ARRAY['sold_out']
        ELSE ARRAY[]::text[]
      END AS reasons
    FROM unnest(
      $4::uuid[], $5::date[], $6::text[], $7::text[], $8::integer[], $9::numeric[],
      $10::integer[], $11::integer[], $12::integer[], $13::text[], $14::integer[], $15::integer[]
    ) AS input(
      room_type_id, stay_date, offer_key, status, available_rooms, price,
      max_adults, max_children, max_occupancy, meal_plan, min_stay, max_stay
    )
  )
  INSERT INTO distribution.public_room_offer_snapshots AS offer (
    property_id, room_type_id, stay_date, public_offer_key, availability_status,
    sellable_publicly, available_rooms, base_price_amount, currency, occupancy, rate_summary,
    unavailable_reasons, freshness_status, data_sources, generated_at, updated_at
  )
  SELECT
    $1::uuid, day.room_type_id, day.stay_date, day.offer_key, day.status, day.sellable,
    day.available_rooms, day.price, $2::text, day.occupancy, day.rate_summary, day.reasons,
    'fresh', ARRAY['pms', 'distribution'], $3::timestamptz, $3::timestamptz
  FROM day
  WHERE NOT EXISTS (
    SELECT 1
    FROM distribution.public_room_offer_snapshots current_offer
    WHERE current_offer.property_id = $1::uuid
      AND current_offer.public_offer_key = day.offer_key
      AND current_offer.stay_date = day.stay_date
      AND (
        current_offer.room_type_id, current_offer.availability_status,
        current_offer.sellable_publicly, current_offer.available_rooms,
        current_offer.base_price_amount, current_offer.currency::text, current_offer.occupancy,
        current_offer.rate_summary, current_offer.unavailable_reasons,
        current_offer.freshness_status, current_offer.data_sources, current_offer.expires_at
      ) IS NOT DISTINCT FROM (
        day.room_type_id, day.status, day.sellable, day.available_rooms, day.price, $2::text,
        day.occupancy, day.rate_summary, day.reasons, 'fresh', ARRAY['pms', 'distribution'],
        NULL::timestamptz
      )
  )
  ON CONFLICT (property_id, public_offer_key, stay_date) DO UPDATE SET
    room_type_id = EXCLUDED.room_type_id,
    availability_status = EXCLUDED.availability_status,
    sellable_publicly = EXCLUDED.sellable_publicly,
    available_rooms = EXCLUDED.available_rooms,
    base_price_amount = EXCLUDED.base_price_amount,
    currency = EXCLUDED.currency,
    occupancy = EXCLUDED.occupancy,
    rate_summary = EXCLUDED.rate_summary,
    unavailable_reasons = EXCLUDED.unavailable_reasons,
    freshness_status = EXCLUDED.freshness_status,
    data_sources = EXCLUDED.data_sources,
    expires_at = NULL,
    generated_at = EXCLUDED.generated_at,
    updated_at = EXCLUDED.updated_at
  RETURNING offer.id::text AS "snapshotId"
`;

/** Closes rows of rooms or offers without current prices, including keys from before pricing v2,
 * keeping their room counts in step with inventory and their recorded prices. */
export const CLOSE_UNPRICED_PUBLIC_OFFERS = `
  UPDATE distribution.public_room_offer_snapshots offer SET
    sellable_publicly = FALSE,
    availability_status = 'closed',
    available_rooms = day.available_rooms,
    unavailable_reasons = ARRAY['unpublished']::text[],
    freshness_status = 'fresh',
    updated_at = $2::timestamptz
  FROM (
    SELECT
      inventory.room_type_id,
      inventory.stay_date,
      CASE WHEN COALESCE(inventory.rate_gate_open, TRUE) AND room.active
        AND NOT EXISTS (
          SELECT 1 FROM pms.room_type_closures closure
          WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
        ) THEN inventory.available_count ELSE 0 END AS available_rooms
    FROM pms.inventory_days inventory
    JOIN pms.room_types room
      ON room.property_id = inventory.property_id AND room.id = inventory.room_type_id
    WHERE inventory.property_id = $1::uuid
  ) day
  WHERE offer.property_id = $1::uuid
    AND offer.room_type_id = day.room_type_id
    AND offer.stay_date = day.stay_date
    AND offer.public_offer_key <> ALL($3::text[])
    AND (
      offer.sellable_publicly, offer.availability_status, offer.available_rooms,
      offer.unavailable_reasons, offer.freshness_status
    ) IS DISTINCT FROM (
      FALSE, 'closed', day.available_rooms, ARRAY['unpublished']::text[], 'fresh'
    )
  RETURNING offer.id::text AS "snapshotId"
`;

/**
 * Projects the current pricing-v2 prices onto PMS inventory as public offer days (VAY-2123):
 * one row per priced room, offer and night from the property's local today. A night is
 * sellable only when the room is active and not closing, the inventory day is open, the rate
 * gate is open, and the offer has a price and no stop-sell that night. Every row written is a
 * current fact, so it is fresh. Like the quotes, it follows pricing-v2 restrictions, not the
 * retired room-level stay rules. Whether owner sources moved on since the save is the public
 * pricing gate's check, not this projection's. Caller holds the property's PMS inventory lock
 * in this transaction. Returns how many rows changed.
 */
export async function projectPmsInventoryToPublicOffers(
  client: Pick<ProjectionClient, "query">,
  propertyId: string,
  projectedAt: Date,
): Promise<number> {
  const at = projectedAt.toISOString();
  // Unreadable prices sell nothing; the hourly pricing freshness check reports them.
  const pricing = await readCurrentPricingSnapshot(client, propertyId).catch((error: unknown) => {
    if (error instanceof PricingStorageError) return null;
    throw error;
  });
  const days = pricing
    ? (await client.query<InventoryDayRow>(READ_PUBLIC_OFFER_INVENTORY_DAYS, [propertyId, at])).rows
    : [];
  const offers = pricing ? pricedOfferDays(pricing, days) : [];
  const column = <K extends keyof PricedOfferDay>(key: K) => offers.map((offer) => offer[key]);
  const upserted = offers.length
    ? await client.query(UPSERT_PRICED_PUBLIC_OFFERS, [
        propertyId,
        pricing!.currency,
        at,
        column("roomTypeId"),
        column("stayDate"),
        column("key"),
        column("status"),
        column("availableRooms"),
        column("price"),
        column("maxAdults"),
        column("maxChildren"),
        column("maxOccupancy"),
        column("mealPlan"),
        column("minStay"),
        column("maxStay"),
      ])
    : { rows: [] };
  const closed = await client.query(CLOSE_UNPRICED_PUBLIC_OFFERS, [
    propertyId,
    at,
    [...new Set(column("key"))],
  ]);
  return upserted.rows.length + closed.rows.length;
}

function pricedOfferDays(
  pricing: StoredPricingRevision,
  days: readonly InventoryDayRow[],
): PricedOfferDay[] {
  const scale = pricingCurrencyScale(pricing.currency);
  const daysByRoom = new Map<string, InventoryDayRow[]>();
  for (const day of days) {
    const roomDays = daysByRoom.get(day.roomTypeId);
    if (roomDays) roomDays.push(day);
    else daysByRoom.set(day.roomTypeId, [day]);
  }
  return pricing.rooms.flatMap((room) => {
    const roomDays = daysByRoom.get(room.roomTypeId) ?? [];
    const terms = Object.fromEntries(room.offers.map((offer) => [offer.id, offer.termsRevision]));
    return room.offers.flatMap((offer) => {
      // The nightly price for one adult, as Channex sends it; quotes stay the price authority.
      const nights = projectReplacementRoomNights(
        room,
        {
          propertyId: room.propertyId,
          roomTypeId: room.roomTypeId,
          offerId: offer.id,
          expectedRevision: room.revision,
          expectedTermsRevisions: terms,
          guests: { adults: 1, childAgesAtCheckIn: [] },
        },
        roomDays.map((day) => day.stayDate),
      );
      return roomDays.map((day, index): PricedOfferDay => {
        const projection = nights[index]!;
        const night = projection.kind === "projected" ? projection.night : null;
        const price = night && scale !== null ? majorAmount(night.totalMinor, scale) : null;
        const sellable = day.open && price !== null && !night!.restrictions.stopSell;
        return {
          roomTypeId: room.roomTypeId,
          stayDate: day.stayDate,
          key: `pricing-v2:${room.roomTypeId}:${offer.id}`,
          status: !sellable
            ? "closed"
            : day.availableCount <= 0
              ? "sold_out"
              : day.availableCount < day.totalCount
                ? "limited"
                : "available",
          availableRooms: day.open ? Math.max(0, day.availableCount) : 0,
          price: price ?? "0",
          maxAdults: room.capacity.adults,
          maxChildren: room.capacity.children,
          maxOccupancy: room.capacity.total,
          mealPlan: offer.meal.kind,
          minStay: night?.restrictions.minArrivalNights ?? null,
          maxStay: night?.restrictions.maxStayNights ?? null,
        };
      });
    });
  });
}

/** Minor units as the column's two-decimal amount, rounded half up; null when it cannot fit. */
function majorAmount(minor: string, scale: number): string | null {
  const divisor = 10n ** BigInt(scale);
  const cents = (BigInt(minor) * 100n + divisor / 2n) / divisor;
  if (cents >= 10n ** 15n) return null;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function createTargetPmsInventoryPublicOfferProjection(
  options: TargetPmsInventoryPublicOfferProjectionOptions,
): TargetPmsInventoryPublicOfferProjection {
  if (!options.connectionString.trim()) {
    throw new Error("PMS inventory public offer projection connectionString must not be empty");
  }
  const ownsPool = !options.pool;
  const pool: ProjectionPool =
    options.pool ?? new pg.Pool({ connectionString: options.connectionString, max: options.max });
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs,
    DEFAULT_PROJECTION_LEASE_DURATION_MS,
    "leaseDurationMs",
  );
  const initialRetryDelayMs = positiveInteger(
    options.initialRetryDelayMs,
    DEFAULT_PROJECTION_RETRY_DELAY_MS,
    "initialRetryDelayMs",
  );
  const maxRetryDelayMs = positiveInteger(
    options.maxRetryDelayMs,
    DEFAULT_PROJECTION_MAX_RETRY_DELAY_MS,
    "maxRetryDelayMs",
  );
  if (maxRetryDelayMs < initialRetryDelayMs) {
    throw new Error("maxRetryDelayMs must be greater than or equal to initialRetryDelayMs");
  }
  const refreshPublicBookability = options.refreshPublicBookability;

  const processClaim = async (
    claim: ProjectionClaim,
    claimedAt: Date,
  ): Promise<PmsInventoryPublicOfferProjectionResult> =>
    projectInventoryClaim(pool, claim, claimedAt, initialRetryDelayMs, refreshPublicBookability);

  const recordFailure = async (
    claim: ProjectionClaim,
    failedAt: Date,
    error: unknown,
  ): Promise<ProjectionClaimFailure> => {
    const retryAt = projectionRetryAt({
      failedAt,
      attemptNumber: claim.nextAttemptNumber,
      initialRetryDelayMs,
      maxRetryDelayMs,
      random,
    });
    return recordProjectionClaimFailure(pool, claim, failedAt, retryAt, error);
  };

  return {
    async projectPending({ propertyId }) {
      const claimedAt = now();
      await recoverExpiredProjectionLeases(pool, {
        propertyId,
        recoveredAt: claimedAt,
      });
      const claim = await claimPendingInventoryEvents(pool, {
        propertyId,
        workerId: "pms-public-offer-projection-sync",
        claimedAt,
        leaseDurationMs,
        includeNotDue: true,
      });
      if (!claim) {
        return emptyProjectionResult();
      }

      try {
        return await processClaim(claim, claimedAt);
      } catch (error) {
        try {
          await recordFailure(claim, now(), error);
        } catch (recordError) {
          throw new AggregateError(
            [error, recordError],
            "PMS inventory public offer projection failed and its retry state could not be recorded",
          );
        }
        throw error;
      }
    },
    async runRetryBatch(batchOptions = {}) {
      const propertyLimit = positiveInteger(
        batchOptions.propertyLimit,
        DEFAULT_PROJECTION_RETRY_PROPERTY_LIMIT,
        "propertyLimit",
      );
      const workerId = batchOptions.workerId?.trim() || "pms-public-offer-projection-retry";
      const result: PmsInventoryPublicOfferRetryBatchResult = {
        processedProperties: 0,
        claimedEvents: 0,
        publishedEvents: 0,
        deferredEvents: 0,
        failedEvents: 0,
        exhaustedEvents: 0,
        projectedOfferDays: 0,
      };

      const recovered = await recoverExpiredProjectionLeases(pool, {
        propertyId: null,
        recoveredAt: now(),
      });
      result.failedEvents += recovered.failedEvents;
      result.exhaustedEvents += recovered.exhaustedEvents;

      for (let index = 0; index < propertyLimit; index += 1) {
        const claimedAt = now();
        const claim = await claimPendingInventoryEvents(pool, {
          propertyId: null,
          workerId,
          claimedAt,
          leaseDurationMs,
          includeNotDue: false,
        });
        if (!claim) break;

        result.processedProperties += 1;
        result.claimedEvents += claim.eventIds.length;
        try {
          const projection = await processClaim(claim, claimedAt);
          result.projectedOfferDays += projection.projectedOfferDays;
          if (projection.profileAvailable) {
            result.publishedEvents += projection.pendingEvents;
          } else {
            result.deferredEvents += projection.pendingEvents;
          }
        } catch (error) {
          const failure = await recordFailure(claim, now(), error);
          result.failedEvents += failure.failedEvents;
          result.exhaustedEvents += failure.exhaustedEvents;
        }
      }

      return result;
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function recoverExpiredProjectionLeases(
  pool: ProjectionPool,
  input: { propertyId: string | null; recoveredAt: Date },
): Promise<ProjectionLeaseRecovery> {
  const client = await pool.connect();
  const failure = {
    type: "ProjectionLeaseExpired",
    message: "PMS inventory public offer projection lease expired before completion",
  };
  try {
    await client.query("BEGIN");
    const recovered = await client.query<FailedEventRow>(
      `UPDATE platform.outbox_events outbox
       SET status = 'failed',
           available_at = CASE
             WHEN outbox.attempts_count >= outbox.max_attempts THEN outbox.available_at
             ELSE $1::timestamptz
           END,
           leased_until = NULL,
           updated_at = $1::timestamptz,
           outbox_metadata = jsonb_set(
             outbox.outbox_metadata,
             '{publicOfferProjection}',
             (
               COALESCE(outbox.outbox_metadata -> 'publicOfferProjection', '{}'::jsonb)
                 - 'leaseToken'
                 - 'leaseExpiresAt'
             ) || jsonb_build_object(
               'lastFailedAt', $1::text,
               'lastError', jsonb_build_object('type', $3::text, 'message', $4::text),
               'attemptNumber', outbox.attempts_count,
               'nextRetryAt', CASE
                 WHEN outbox.attempts_count >= outbox.max_attempts THEN NULL
                 ELSE $1::text
               END,
               'exhausted', outbox.attempts_count >= outbox.max_attempts
             ),
             true
           )
       WHERE ${PUBLIC_OFFER_PROJECTION_EVENT_FILTER}
         AND outbox.tenant_scope = 'property'
         AND outbox.status = 'leased'
         AND outbox.leased_until <= $1::timestamptz
         AND ($2::uuid IS NULL OR outbox.property_id = $2::uuid)
       RETURNING
         outbox.id::text AS "outboxEventId",
         outbox.attempts_count AS "attemptsCount",
         outbox.max_attempts AS "maxAttempts"`,
      [input.recoveredAt.toISOString(), input.propertyId, failure.type, failure.message],
    );
    const exhaustedEventIds = recovered.rows
      .filter((row) => row.attemptsCount >= row.maxAttempts)
      .map((row) => row.outboxEventId);
    if (exhaustedEventIds.length > 0) {
      await insertProjectionDeadLetters(client, {
        eventIds: exhaustedEventIds,
        failure,
        workerId: "pms-public-offer-projection-lease-recovery",
      });
    }
    await client.query("COMMIT");
    return {
      failedEvents: recovered.rows.length,
      exhaustedEvents: exhaustedEventIds.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimPendingInventoryEvents(
  pool: ProjectionPool,
  input: {
    propertyId: string | null;
    workerId: string;
    claimedAt: Date;
    leaseDurationMs: number;
    includeNotDue: boolean;
  },
): Promise<ProjectionClaim | null> {
  const client = await pool.connect();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(input.claimedAt.getTime() + input.leaseDurationMs);
  try {
    await client.query("BEGIN");
    const claimed = await client.query<ClaimedEventRow>(CLAIM_PENDING_INVENTORY_EVENTS, [
      input.claimedAt.toISOString(),
      input.propertyId,
      leaseExpiresAt.toISOString(),
      input.workerId,
      leaseToken,
      input.includeNotDue,
    ]);
    await client.query("COMMIT");
    const first = claimed.rows[0];
    if (!first) return null;
    return {
      propertyId: first.propertyId,
      eventIds: claimed.rows.map((row) => row.outboxEventId),
      nextAttemptNumber: Math.max(...claimed.rows.map((row) => row.attemptsCount)),
      leaseToken,
      workerId: input.workerId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function projectInventoryClaim(
  pool: ProjectionPool,
  claim: ProjectionClaim,
  projectedAt: Date,
  profileUnavailableDelayMs: number,
  refreshPublicBookability?: (command: { propertyId: string }) => Promise<void>,
): Promise<PmsInventoryPublicOfferProjectionResult> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const owned = await client.query<ClaimedEventRow>(
      `SELECT
         outbox.id::text AS "outboxEventId",
         outbox.property_id::text AS "propertyId",
         outbox.attempts_count AS "attemptsCount",
         outbox.max_attempts AS "maxAttempts"
       FROM platform.outbox_events outbox
       WHERE outbox.property_id = $1::uuid
         AND outbox.id = ANY($2::uuid[])
         AND ${PUBLIC_OFFER_PROJECTION_EVENT_FILTER}
         AND outbox.status = 'leased'
         AND outbox.outbox_metadata #>> '{publicOfferProjection,leaseToken}' = $3
       ORDER BY outbox.created_at, outbox.id
       FOR UPDATE`,
      [claim.propertyId, claim.eventIds, claim.leaseToken],
    );
    if (owned.rows.length === 0) {
      await client.query("COMMIT");
      transactionOpen = false;
      return emptyProjectionResult();
    }

    const ownedEventIds = owned.rows.map((row) => row.outboxEventId);
    const profile = await client.query(
      `SELECT 1
       FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid
         AND profile_status = 'public'
       LIMIT 1`,
      [claim.propertyId],
    );
    if (profile.rows.length === 0) {
      const retryAt = new Date(projectedAt.getTime() + profileUnavailableDelayMs);
      await client.query(
        `UPDATE platform.outbox_events outbox
         SET status = 'pending',
             attempts_count = GREATEST(0, outbox.attempts_count - 1),
             available_at = $4::timestamptz,
             leased_until = NULL,
             updated_at = $5::timestamptz,
             outbox_metadata = jsonb_set(
               outbox.outbox_metadata,
               '{publicOfferProjection}',
               (
                 COALESCE(outbox.outbox_metadata -> 'publicOfferProjection', '{}'::jsonb)
                   - 'leaseToken'
                   - 'leaseExpiresAt'
               ) || jsonb_build_object(
                 'lastWorkerId', $3::text,
                 'lastDeferredAt', $5::text,
                 'lastDeferredReason', 'public_profile_unavailable',
                 'nextRetryAt', $4::text
               ),
               true
             )
         WHERE outbox.property_id = $1::uuid
           AND outbox.id = ANY($2::uuid[])
           AND outbox.status = 'leased'
           AND outbox.outbox_metadata #>> '{publicOfferProjection,leaseToken}' = $6`,
        [
          claim.propertyId,
          ownedEventIds,
          claim.workerId,
          retryAt.toISOString(),
          projectedAt.toISOString(),
          claim.leaseToken,
        ],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        profileAvailable: false,
        pendingEvents: ownedEventIds.length,
        projectedOfferDays: 0,
      };
    }

    // Acquire in a separate statement so a waiter reads a fresh snapshot after closure commits.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(concat('pms-inventory:', $1::text), 0))",
      [claim.propertyId],
    );
    const projectedOfferDays = await projectPmsInventoryToPublicOffers(
      client,
      claim.propertyId,
      projectedAt,
    );
    await client.query("COMMIT");
    transactionOpen = false;

    await refreshPublicBookability?.({ propertyId: claim.propertyId });

    await client.query("BEGIN");
    transactionOpen = true;
    const acknowledged = await client.query(
      `UPDATE platform.outbox_events outbox
       SET status = 'published',
           published_at = $4::timestamptz,
           leased_until = NULL,
           updated_at = $4::timestamptz,
           outbox_metadata = jsonb_set(
             outbox.outbox_metadata,
             '{publicOfferProjection}',
             (
               COALESCE(outbox.outbox_metadata -> 'publicOfferProjection', '{}'::jsonb)
                 - 'leaseToken'
                 - 'leaseExpiresAt'
                 - 'lastError'
                 - 'nextRetryAt'
                 - 'exhausted'
             ) || jsonb_build_object(
               'lastWorkerId', $3::text,
               'lastSucceededAt', $4::text
             ),
             true
           )
       WHERE outbox.property_id = $1::uuid
         AND outbox.id = ANY($2::uuid[])
         AND outbox.status = 'leased'
         AND outbox.outbox_metadata #>> '{publicOfferProjection,leaseToken}' = $5`,
      [
        claim.propertyId,
        ownedEventIds,
        claim.workerId,
        projectedAt.toISOString(),
        claim.leaseToken,
      ],
    );
    if ((acknowledged.rowCount ?? 0) !== ownedEventIds.length) {
      throw new Error("PMS inventory public offer projection lease was lost before acknowledgment");
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      profileAvailable: true,
      pendingEvents: ownedEventIds.length,
      projectedOfferDays,
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordProjectionClaimFailure(
  pool: ProjectionPool,
  claim: ProjectionClaim,
  failedAt: Date,
  retryAt: Date,
  error: unknown,
): Promise<ProjectionClaimFailure> {
  const client = await pool.connect();
  const failure = sanitizedProjectionFailure(error);
  try {
    await client.query("BEGIN");
    const failed = await client.query<FailedEventRow>(
      `UPDATE platform.outbox_events outbox
       SET status = 'failed',
           available_at = CASE
             WHEN outbox.attempts_count >= outbox.max_attempts THEN outbox.available_at
             ELSE $4::timestamptz
           END,
           leased_until = NULL,
           updated_at = $5::timestamptz,
           outbox_metadata = jsonb_set(
             outbox.outbox_metadata,
             '{publicOfferProjection}',
             (
               COALESCE(outbox.outbox_metadata -> 'publicOfferProjection', '{}'::jsonb)
                 - 'leaseToken'
                 - 'leaseExpiresAt'
             ) || jsonb_build_object(
               'lastWorkerId', $3::text,
               'lastFailedAt', $5::text,
               'lastError', jsonb_build_object('type', $6::text, 'message', $7::text),
               'attemptNumber', outbox.attempts_count,
               'nextRetryAt', CASE
                 WHEN outbox.attempts_count >= outbox.max_attempts THEN NULL
                 ELSE $4::text
               END,
               'exhausted', outbox.attempts_count >= outbox.max_attempts
             ),
             true
           )
       WHERE outbox.property_id = $1::uuid
         AND outbox.id = ANY($2::uuid[])
         AND outbox.status = 'leased'
         AND outbox.outbox_metadata #>> '{publicOfferProjection,leaseToken}' = $8
       RETURNING
         outbox.id::text AS "outboxEventId",
         outbox.attempts_count AS "attemptsCount",
         outbox.max_attempts AS "maxAttempts"`,
      [
        claim.propertyId,
        claim.eventIds,
        claim.workerId,
        retryAt.toISOString(),
        failedAt.toISOString(),
        failure.type,
        failure.message,
        claim.leaseToken,
      ],
    );
    const exhaustedEventIds = failed.rows
      .filter((row) => row.attemptsCount >= row.maxAttempts)
      .map((row) => row.outboxEventId);
    if (exhaustedEventIds.length > 0) {
      await insertProjectionDeadLetters(client, {
        eventIds: exhaustedEventIds,
        failure,
        workerId: claim.workerId,
      });
    }
    await client.query("COMMIT");
    return {
      failedEvents: failed.rows.length,
      exhaustedEvents: exhaustedEventIds.length,
    };
  } catch (recordError) {
    await client.query("ROLLBACK");
    throw recordError;
  } finally {
    client.release();
  }
}

async function insertProjectionDeadLetters(
  queryable: ProjectionClient,
  input: {
    eventIds: string[];
    failure: { type: string; message: string };
    workerId: string;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO platform.dead_letter_events
       (
         source_kind,
         outbox_event_id,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         reason_code,
         failure_summary,
         failure_payload
       )
     SELECT
       'outbox_event',
       outbox.id,
       outbox.tenant_scope,
       outbox.property_id,
       outbox.resource_product,
       outbox.resource_type,
       outbox.resource_id,
       outbox.correlation_id,
       outbox.idempotency_key_hash,
       'max_attempts_exhausted',
       $2,
       jsonb_build_object(
         'ownerPackage', 'domain-distribution',
         'destination', outbox.destination,
         'eventType', outbox.event_type,
         'attemptCount', outbox.attempts_count,
         'maxAttempts', outbox.max_attempts,
         'workerId', $3::text,
         'errorType', $4::text,
         'replayEligible', true
       )
     FROM platform.outbox_events outbox
     WHERE outbox.id = ANY($1::uuid[])
       AND NOT EXISTS (
         SELECT 1
         FROM platform.dead_letter_events existing
         WHERE existing.source_kind = 'outbox_event'
           AND existing.outbox_event_id = outbox.id
           AND existing.reason_code = 'max_attempts_exhausted'
           AND existing.recovery_status IN ('open', 'acknowledged')
       )`,
    [input.eventIds, input.failure.message, input.workerId, input.failure.type],
  );
}

function projectionRetryAt(input: {
  failedAt: Date;
  attemptNumber: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  random: () => number;
}): Date {
  const exponentialDelay = Math.min(
    input.maxRetryDelayMs,
    input.initialRetryDelayMs * 2 ** Math.max(0, input.attemptNumber - 1),
  );
  const jitter = 0.5 + Math.min(1, Math.max(0, input.random())) * 0.5;
  return new Date(input.failedAt.getTime() + Math.max(1, Math.round(exponentialDelay * jitter)));
}

function sanitizedProjectionFailure(error: unknown): { type: string; message: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const type =
    typeof record["name"] === "string" && record["name"].trim()
      ? record["name"].trim().slice(0, 100)
      : "ProjectionError";
  const databaseCode =
    typeof record["code"] === "string" && record["code"].trim()
      ? record["code"].trim().slice(0, 40)
      : null;
  const rawMessage =
    error instanceof Error && error.message.trim()
      ? error.message
      : "PMS inventory public offer projection failed";
  const message = rawMessage
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/\b(password|secret|token)=\S+/gi, "$1=[redacted]")
    .slice(0, 500);
  return {
    type: databaseCode ? `${type}:${databaseCode}` : type,
    message,
  };
}

function emptyProjectionResult(): PmsInventoryPublicOfferProjectionResult {
  return { profileAvailable: false, pendingEvents: 0, projectedOfferDays: 0 };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}
