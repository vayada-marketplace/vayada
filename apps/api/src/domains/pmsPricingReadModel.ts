import {
  PMS_PRICING_CONTRACT_VERSION,
  isMinorAmount,
  parseFlexibleRatePlanSnapshot,
  pricingCurrencyScale,
  parsePmsPricingSourceSnapshot,
  parsePropertyPricingCurrencySnapshot,
  type FlexibleRatePlanSnapshot,
  type PmsPricingReadPort,
  type PropertyPricingCurrencySnapshot,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsPricingReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsPricingReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsPricingReadClient>;
  end?(): Promise<void>;
};

export type PmsPricingReadModel = PmsPricingReadPort & { close(): Promise<void> };

export type PmsPricingCurrencyRow = {
  propertyId: string;
  currency: string;
  pricingCurrencyRevision: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PmsFlexibleRatePlanRow = {
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  flexibleRatePlanRevision: number | string;
  sourceRoomFactsRevision: number | string;
  amountDecimal: string;
  currency: string;
  cancellationTerms: unknown;
  mealPlan?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type Queryable = Pick<PmsPricingReadClient, "query">;
type PmsPricingSourcesRow = {
  pricingCurrency: PmsPricingCurrencyRow | null;
  flexibleRatePlans: PmsFlexibleRatePlanRow[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CURRENCY_SELECT = `SELECT
  settings.property_id::text AS "propertyId",
  settings.currency::text AS currency,
  settings.pricing_currency_revision AS "pricingCurrencyRevision",
  settings.created_at AS "createdAt",
  settings.updated_at AS "updatedAt"
FROM pms.property_pricing_settings settings`;

const PLAN_SELECT = `SELECT
  plan.property_id::text AS "propertyId",
  plan.room_type_id::text AS "roomTypeId",
  plan.id::text AS "flexibleRatePlanId",
  plan.flexible_rate_plan_revision AS "flexibleRatePlanRevision",
  plan.source_room_facts_revision AS "sourceRoomFactsRevision",
  plan.base_rate_amount::text AS "amountDecimal",
  plan.currency::text AS currency,
  plan.meal_plan AS "mealPlan",
  COALESCE(cancellation_extension.cancellation_terms, plan.cancellation_policy_snapshot)
    AS "cancellationTerms",
  plan.created_at AS "createdAt",
  plan.updated_at AS "updatedAt"
FROM pms.rate_plans plan
LEFT JOIN pms.flexible_rate_plan_cancellation_extensions cancellation_extension
  ON cancellation_extension.flexible_rate_plan_id = plan.id
 AND cancellation_extension.property_id = plan.property_id
 AND cancellation_extension.room_type_id = plan.room_type_id
 AND cancellation_extension.pricing_contract_version = plan.pricing_contract_version`;

// Every offer of the active pricing-v2 publication with the Booking terms it references, room by room.
const PUBLISHED_OFFER_SELECT = `SELECT
  room.room_type_id::text AS "roomTypeId",
  room.currency::text AS currency,
  room_type.room_facts_revision AS "sourceRoomFactsRevision",
  head.revision AS "pricingRevision",
  revision.created_at AS "publishedAt",
  offer.value AS offer,
  terms.terms AS terms
FROM pms.pricing_v2_heads head
JOIN pms.pricing_v2_revisions revision
  ON revision.property_id = head.property_id AND revision.revision = head.revision
JOIN pms.pricing_v2_rooms room
  ON room.property_id = head.property_id AND room.revision = head.revision
JOIN pms.room_types room_type
  ON room_type.property_id = room.property_id AND room_type.id = room.room_type_id AND room_type.active
CROSS JOIN LATERAL jsonb_array_elements(room.configuration->'offers') WITH ORDINALITY AS offer(value, position)
-- The terms revision the publication references (immutable), as manual-booking pricing reads it.
JOIN booking.pricing_v2_offer_terms terms
  ON terms.property_id = room.property_id AND terms.room_type_id = room.room_type_id
 AND terms.offer_id = offer.value->>'id' AND terms.revision::text = offer.value->>'termsRevision'
WHERE head.property_id = $1::uuid
ORDER BY room.room_type_id, offer.position`;

type PublishedOfferRow = {
  roomTypeId: string;
  currency: string;
  sourceRoomFactsRevision: number | string;
  pricingRevision: number | string;
  publishedAt: Date | string;
  offer: Record<string, any>;
  terms: Record<string, any>;
};

const PRICING_SOURCES_SELECT = `WITH pricing_currency AS (
  ${CURRENCY_SELECT}
  WHERE settings.property_id = $1::uuid
), flexible_rate_plans AS (
  ${PLAN_SELECT}
  WHERE plan.property_id = $1::uuid
    AND plan.pricing_contract_version = $2
    AND EXISTS (
      SELECT 1 FROM pms.room_types room
      WHERE room.property_id = plan.property_id
        AND room.id = plan.room_type_id
        AND room.active
        AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closure
          WHERE closure.property_id=room.property_id AND closure.room_type_id=room.id)
    )
)
SELECT
  (SELECT row_to_json(currency_row) FROM pricing_currency currency_row) AS "pricingCurrency",
  COALESCE(
    (SELECT json_agg(plan ORDER BY plan."roomTypeId") FROM flexible_rate_plans plan),
    '[]'::json
  ) AS "flexibleRatePlans"`;

export function createPgPmsPricingReadModel(config: {
  connectionString: string;
  max?: number;
  pool?: PmsPricingReadPool;
  now?: () => Date;
}): PmsPricingReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS pricing read model connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsPricingReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async getPropertyPricingCurrency(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      return queryCurrency(pool, normalizedPropertyId);
    },

    async getFlexibleRatePlan(propertyId, roomTypeId) {
      const normalizedRoomTypeId = readUuid(roomTypeId);
      const plans = await readPublishedFlexibleRatePlans(pool, readUuid(propertyId));
      return plans.find((plan) => plan.roomTypeId === normalizedRoomTypeId) ?? null;
    },

    async listFlexibleRatePlans(propertyId) {
      return readPublishedFlexibleRatePlans(pool, readUuid(propertyId));
    },

    async getPricingSourceSnapshot(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const snapshot = await loadPmsPricingSourceSnapshot(client, normalizedPropertyId, now());
        await client.query("COMMIT");
        return snapshot;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS pricing read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

/** Read adapter over the active pricing-v2 publication (slice A.2): one flexible plan per room,
 * from the first independently priced offer whose current terms are refundable. Rooms without
 * one, offers without a base price and non-UUID offer ids have no flexible plan. */
export async function readPublishedFlexibleRatePlans(
  queryable: Queryable,
  propertyId: string,
): Promise<FlexibleRatePlanSnapshot[]> {
  const rows = await readPublishedOfferRows(queryable, propertyId);
  const plans = new Map<string, FlexibleRatePlanSnapshot>();
  for (const row of rows) {
    if (plans.has(row.roomTypeId)) continue;
    const plan = publishedFlexibleRatePlan(propertyId, row);
    if (plan) plans.set(row.roomTypeId, plan);
  }
  return [...plans.values()];
}

/** True once the property has a pricing-v2 publication; it then supersedes the retired legacy
 * flexible plans and recurring pricing in the PMS pricing source. */
export async function hasPricingPublication(queryable: Queryable, propertyId: string) {
  const head = await queryable.query(
    "SELECT 1 FROM pms.pricing_v2_heads WHERE property_id = $1::uuid",
    [propertyId],
  );
  return head.rows.length > 0;
}

/** Flexible plans of the PMS pricing source once the property has a pricing-v2 publication:
 * the published adapter, limited to open rooms like the legacy rows and to the property's
 * pricing currency (a plan in another currency is missing, not malformed). Null without a
 * publication, so the caller keeps the legacy rows. The pricing source and the
 * mandatory-charge fingerprint both read this, so their evidence stays identical. */
export async function readSourcePublishedFlexibleRatePlans(
  queryable: Queryable,
  propertyId: string,
  currency: string,
): Promise<FlexibleRatePlanSnapshot[] | null> {
  if (!(await hasPricingPublication(queryable, propertyId))) return null;
  const closed = await queryable.query<{ roomTypeId: string }>(
    `SELECT room_type_id::text AS "roomTypeId" FROM pms.room_type_closures
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  const closedRoomIds = new Set(closed.rows.map(({ roomTypeId }) => roomTypeId));
  return (await readPublishedFlexibleRatePlans(queryable, propertyId)).filter(
    (plan) => !closedRoomIds.has(plan.roomTypeId) && plan.baseAmount.currency === currency,
  );
}

/** Every published offer for rate-plan lists (e.g. the New Booking dropdown), in editor order.
 * Labels come from the offer's current terms; only independent offers carry a base amount. */
export type PublishedRatePlan = Readonly<{
  roomTypeId: string;
  ratePlanId: string;
  rateType: "flexible" | "non_refundable";
  mealPlan: string | null;
  /** Publication currency; room types from the room-facts flow carry none. */
  currency: string;
  baseAmount: Readonly<{ amountDecimal: string; currency: string }> | null;
  cancellation: Record<string, unknown>;
}>;

export async function readPublishedRatePlans(
  queryable: Queryable,
  propertyId: string,
): Promise<PublishedRatePlan[]> {
  return (await readPublishedOfferRows(queryable, propertyId)).flatMap((row) => {
    const { offer, terms } = row;
    const rateType = terms?.cancellation?.kind;
    if (typeof offer?.id !== "string" || (rateType !== "flexible" && rateType !== "non_refundable"))
      return [];
    const minor =
      offer.price?.kind === "independent" ? baseMinor(offer.price.calendar?.base) : null;
    const scale = pricingCurrencyScale(row.currency);
    const amountDecimal = minor === null || scale === null ? null : minorToDecimal(minor, scale);
    return [
      {
        roomTypeId: row.roomTypeId,
        ratePlanId: offer.id,
        rateType,
        mealPlan: typeof offer.meal?.kind === "string" ? offer.meal.kind : null,
        currency: row.currency,
        baseAmount: amountDecimal === null ? null : { amountDecimal, currency: row.currency },
        cancellation: terms.cancellation,
      },
    ];
  });
}

async function readPublishedOfferRows(queryable: Queryable, propertyId: string) {
  return (await queryable.query<PublishedOfferRow>(PUBLISHED_OFFER_SELECT, [propertyId])).rows;
}

function publishedFlexibleRatePlan(
  propertyId: string,
  row: PublishedOfferRow,
): FlexibleRatePlanSnapshot | null {
  const { offer, terms } = row;
  if (offer?.price?.kind !== "independent" || terms?.cancellation?.kind !== "flexible") return null;
  const minor = baseMinor(offer.price.calendar?.base);
  const scale = pricingCurrencyScale(row.currency);
  const amountDecimal = minor === null || scale === null ? null : minorToDecimal(minor, scale);
  if (amountDecimal === null) return null;
  const mealPlan = offer.meal?.kind;
  const publishedAt = isoDate(row.publishedAt);
  return parseFlexibleRatePlanSnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    roomTypeId: row.roomTypeId,
    flexibleRatePlanId: offer.id,
    flexibleRatePlanRevision: positiveInteger(row.pricingRevision),
    sourceRoomFactsRevision: positiveInteger(row.sourceRoomFactsRevision),
    baseAmount: { amountDecimal, currency: row.currency },
    cancellationTerms: terms.cancellation.terms,
    ...(mealPlan === "room_only" || mealPlan === "breakfast" ? { mealPlan } : {}),
    createdAt: publishedAt,
    updatedAt: publishedAt,
  });
}

/** The base calendar's single-occupancy amount, whatever the room-price mode. */
function baseMinor(base: Record<string, any> | null | undefined): string | null {
  const minor =
    base?.mode === "flat"
      ? base.amountMinor
      : base?.mode === "occupancy"
        ? base.amountsMinor?.[0]
        : base?.mode === "per_person"
          ? base.unitMinor
          : base?.mode === "included_guests"
            ? base.baseMinor
            : null;
  return isMinorAmount(minor) ? minor : null;
}

/** PMS money is always written with two decimals; null when the amount needs more precision. */
function minorToDecimal(minor: string, scale: number): string | null {
  const padded = minor.padStart(scale + 1, "0");
  const units = scale === 0 ? padded : padded.slice(0, -scale);
  const fraction = (scale === 0 ? "" : padded.slice(-scale)).padEnd(2, "0");
  return /^0*$/.test(fraction.slice(2)) ? `${units}.${fraction.slice(0, 2)}` : null;
}

export async function loadPmsPricingSourceSnapshot(
  queryable: Queryable,
  propertyId: string,
  captured: Date,
) {
  const normalizedPropertyId = readUuid(propertyId);
  const result = await queryable.query<PmsPricingSourcesRow>(PRICING_SOURCES_SELECT, [
    normalizedPropertyId,
    PMS_PRICING_CONTRACT_VERSION,
  ]);
  if (result.rows.length !== 1) throw new Error("PMS pricing sources read is malformed");
  const row = result.rows[0]!;
  if (!row.pricingCurrency) return null;
  const published = await readSourcePublishedFlexibleRatePlans(
    queryable,
    normalizedPropertyId,
    row.pricingCurrency.currency,
  );
  const snapshot = parsePmsPricingSourceSnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: normalizedPropertyId,
    pricingCurrency: pmsPricingCurrencySnapshotFromRow(row.pricingCurrency),
    flexibleRatePlans: published ?? row.flexibleRatePlans.map(pmsFlexibleRatePlanSnapshotFromRow),
    capturedAt: validDate(captured) ? captured.toISOString() : null,
  });
  if (!snapshot) throw new Error("PMS pricing source failed contract validation");
  return snapshot;
}

export function pmsPricingCurrencySnapshotFromRow(
  row: PmsPricingCurrencyRow,
): PropertyPricingCurrencySnapshot {
  const parsed = parsePropertyPricingCurrencySnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: row.propertyId,
    currency: row.currency,
    pricingCurrencyRevision: positiveInteger(row.pricingCurrencyRevision),
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  });
  if (!parsed) throw new Error("PMS pricing currency row failed contract validation");
  return parsed;
}

export function pmsFlexibleRatePlanSnapshotFromRow(
  row: PmsFlexibleRatePlanRow,
): FlexibleRatePlanSnapshot {
  const parsed = parseFlexibleRatePlanSnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    flexibleRatePlanId: row.flexibleRatePlanId,
    flexibleRatePlanRevision: positiveInteger(row.flexibleRatePlanRevision),
    sourceRoomFactsRevision: positiveInteger(row.sourceRoomFactsRevision),
    baseAmount: { amountDecimal: row.amountDecimal, currency: row.currency },
    cancellationTerms: row.cancellationTerms,
    mealPlan: row.mealPlan ?? "room_only",
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  });
  if (!parsed) throw new Error("PMS flexible pricing plan row failed contract validation");
  return parsed;
}

export async function queryCurrency(
  queryable: {
    query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  },
  propertyId: string,
): Promise<PropertyPricingCurrencySnapshot | null> {
  const result = await queryable.query<PmsPricingCurrencyRow>(
    `${CURRENCY_SELECT}
     WHERE settings.property_id = $1::uuid`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS property pricing currency is not unique");
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = pmsPricingCurrencySnapshotFromRow(row);
  if (snapshot.propertyId !== propertyId) {
    throw new Error("PMS pricing currency read escaped its property scope");
  }
  return snapshot;
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("PMS pricing read scope is malformed");
  return value.toLowerCase();
}

function positiveInteger(value: number | string): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function databaseInteger(value: number | string): number {
  if (typeof value === "number") return value;
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function isoDate(value: Date | string): string | null {
  const parsed = typeof value === "string" ? new Date(value) : value;
  return validDate(parsed) ? parsed.toISOString() : null;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function rollbackQuietly(client: PmsPricingReadClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original read error.
  }
}
