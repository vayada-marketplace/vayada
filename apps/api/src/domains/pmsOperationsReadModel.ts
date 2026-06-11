import pg from "pg";

export type PmsDecimalAmount = string;
export type PmsCurrencyCode = string;
export type PmsJsonScalar = string | number | boolean | null;
export type PmsJsonRecord = Record<string, PmsJsonScalar>;

export type PmsMoney = {
  amountDecimal: PmsDecimalAmount;
  currency: PmsCurrencyCode;
};

export type PmsRoomStatus = "available" | "maintenance" | "out_of_order" | "retired";

export type PmsRoom = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: PmsRoomStatus;
  sortOrder: number;
  metadata: PmsJsonRecord;
};

export type PmsRatePlan = {
  ratePlanId: string;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRate: PmsMoney;
  active: boolean;
};

export type PmsRateRulesSummary = {
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: number;
};

export type PmsRoomTypeMedia = {
  url: string;
  altText?: string | null;
};

export type PmsRoomType = {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: PmsJsonRecord;
  amenities: string[];
  media: PmsRoomTypeMedia[];
  baseRate: PmsMoney;
  active: boolean;
  sortOrder: number;
  ratePlans: PmsRatePlan[];
  rateRulesSummary: PmsRateRulesSummary;
  roomCount: number;
};

export type PmsSourceFreshness = Record<string, PmsJsonScalar>;

export type PmsOperationsReadResult<T> = {
  items: T[];
  sourceFreshness?: PmsSourceFreshness;
};

export type PmsOperationsReadRepository = {
  listRoomsByPropertyId(propertyId: string): Promise<PmsOperationsReadResult<PmsRoom>>;
  listRoomTypesByPropertyId(propertyId: string): Promise<PmsOperationsReadResult<PmsRoomType>>;
  findRoomTypeById(propertyId: string, roomTypeId: string): Promise<PmsRoomType | null>;
  close?(): Promise<void>;
};

export type PmsOperationsReadPool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
  end?(): Promise<void>;
};

export function createTargetPmsOperationsReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PmsOperationsReadPool;
}): PmsOperationsReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS operations repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listRoomsByPropertyId(propertyId) {
      const result = await pool.query<TargetPmsRoomRow>(
        `SELECT
           room.id::text AS "roomId",
           room.room_type_id::text AS "roomTypeId",
           room.room_number AS "roomNumber",
           room.floor,
           room.status,
           room.sort_order AS "sortOrder",
           room.room_metadata AS "metadata"
         FROM pms.rooms room
         JOIN pms.room_types room_type
           ON room_type.id = room.room_type_id
          AND room_type.property_id = room.property_id
         WHERE room.property_id = $1
         ORDER BY room.sort_order ASC, room.room_number ASC`,
        [propertyId],
      );

      return {
        items: result.rows.map(toPmsRoom),
        sourceFreshness: {},
      };
    },

    async listRoomTypesByPropertyId(propertyId) {
      return listRoomTypes(pool, propertyId);
    },

    async findRoomTypeById(propertyId, roomTypeId) {
      const result = await listRoomTypes(pool, propertyId, roomTypeId);
      return result.items[0] ?? null;
    },

    async close() {
      await pool.end?.();
    },
  };
}

type TargetPmsRoomRow = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: PmsRoomStatus;
  sortOrder: number;
  metadata: unknown;
};

type TargetPmsRoomTypeRow = {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: unknown;
  attributes: unknown;
  amenities: unknown;
  media: unknown;
  baseRateAmount: string | number;
  currency: string;
  active: boolean;
  sortOrder: number;
  ratePlans: unknown;
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: string | number;
  roomCount: string | number;
};

async function listRoomTypes(
  pool: PmsOperationsReadPool,
  propertyId: string,
  roomTypeId?: string,
): Promise<PmsOperationsReadResult<PmsRoomType>> {
  const params: unknown[] = [propertyId];
  const roomTypeFilter = roomTypeId ? "AND room_type.id = $2" : "";
  if (roomTypeId) params.push(roomTypeId);

  const result = await pool.query<TargetPmsRoomTypeRow>(
    `SELECT
       room_type.id::text AS "roomTypeId",
       room_type.name,
       room_type.description,
       room_type.category,
       room_type.occupancy_limits AS "occupancyLimits",
       room_type.room_attributes AS "attributes",
       room_type.amenities_snapshot AS "amenities",
       room_type.media_snapshot AS "media",
       room_type.base_rate_amount AS "baseRateAmount",
       room_type.currency,
       room_type.active,
       room_type.sort_order AS "sortOrder",
       COALESCE(rate_plans.items, '[]'::jsonb) AS "ratePlans",
       rate_rules.min_stay_nights AS "minStayNights",
       rate_rules.max_stay_nights AS "maxStayNights",
       COALESCE(rate_rules.closed_to_arrival, FALSE) AS "closedToArrival",
       COALESCE(rate_rules.closed_to_departure, FALSE) AS "closedToDeparture",
       COALESCE(rate_rules.active_rule_count, 0) AS "activeRuleCount",
       COALESCE(room_counts.room_count, 0) AS "roomCount"
     FROM pms.room_types room_type
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'ratePlanId', rate_plan.id::text,
                  'code', rate_plan.code,
                  'name', rate_plan.name,
                  'rateType', rate_plan.rate_type,
                  'mealPlan', rate_plan.meal_plan,
                  'baseRate', jsonb_build_object(
                    'amountDecimal', rate_plan.base_rate_amount::text,
                    'currency', rate_plan.currency
                  ),
                  'active', rate_plan.active
                )
                ORDER BY rate_plan.code ASC, rate_plan.name ASC
              ) AS items
       FROM pms.rate_plans rate_plan
       WHERE rate_plan.property_id = room_type.property_id
         AND rate_plan.room_type_id = room_type.id
     ) rate_plans ON TRUE
     LEFT JOIN LATERAL (
       SELECT
         MIN(rule.min_stay_nights) FILTER (WHERE rule.min_stay_nights IS NOT NULL)
           AS min_stay_nights,
         MAX(rule.max_stay_nights) FILTER (WHERE rule.max_stay_nights IS NOT NULL)
           AS max_stay_nights,
         BOOL_OR(rule.closed_to_arrival) AS closed_to_arrival,
         BOOL_OR(rule.closed_to_departure) AS closed_to_departure,
         COUNT(*) AS active_rule_count
       FROM pms.rate_rules rule
       WHERE rule.property_id = room_type.property_id
         AND rule.room_type_id = room_type.id
     ) rate_rules ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS room_count
       FROM pms.rooms room
       WHERE room.property_id = room_type.property_id
         AND room.room_type_id = room_type.id
         AND room.status <> 'retired'
     ) room_counts ON TRUE
     WHERE room_type.property_id = $1
       ${roomTypeFilter}
     ORDER BY room_type.sort_order ASC, room_type.name ASC`,
    params,
  );

  return {
    items: result.rows.map(toPmsRoomType),
    sourceFreshness: {},
  };
}

function toPmsRoom(row: TargetPmsRoomRow): PmsRoom {
  return {
    roomId: row.roomId,
    roomTypeId: row.roomTypeId,
    roomNumber: row.roomNumber,
    floor: row.floor,
    status: row.status,
    sortOrder: row.sortOrder,
    metadata: toJsonRecord(row.metadata),
  };
}

function toPmsRoomType(row: TargetPmsRoomTypeRow): PmsRoomType {
  return {
    roomTypeId: row.roomTypeId,
    name: row.name,
    description: row.description,
    category: row.category,
    occupancyLimits: toNumberRecord(row.occupancyLimits),
    attributes: toJsonRecord(row.attributes),
    amenities: toStringArray(row.amenities),
    media: toMediaArray(row.media),
    baseRate: {
      amountDecimal: toDecimalString(row.baseRateAmount),
      currency: row.currency,
    },
    active: row.active,
    sortOrder: row.sortOrder,
    ratePlans: toRatePlans(row.ratePlans),
    rateRulesSummary: {
      minStayNights: row.minStayNights,
      maxStayNights: row.maxStayNights,
      closedToArrival: row.closedToArrival,
      closedToDeparture: row.closedToDeparture,
      activeRuleCount: toInteger(row.activeRuleCount),
    },
    roomCount: toInteger(row.roomCount),
  };
}

function toJsonRecord(value: unknown): PmsJsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, PmsJsonScalar] =>
      isJsonScalar(entry[1]),
    ),
  );
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter(([, raw]) => Number.isFinite(raw)),
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toMediaArray(value: unknown): PmsRoomTypeMedia[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const url = typeof item.url === "string" ? item.url : "";
      const altText =
        typeof item.altText === "string"
          ? item.altText
          : typeof item.alt === "string"
            ? item.alt
            : null;
      return { url, altText };
    })
    .filter((item) => item.url.length > 0);
}

function toRatePlans(value: unknown): PmsRatePlan[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      ratePlanId: String(item.ratePlanId ?? ""),
      code: String(item.code ?? ""),
      name: String(item.name ?? ""),
      rateType: toRateType(item.rateType),
      mealPlan: typeof item.mealPlan === "string" ? item.mealPlan : null,
      baseRate: toMoney(item.baseRate),
      active: item.active === true,
    }))
    .filter((item) => item.ratePlanId.length > 0);
}

function toRateType(value: unknown): PmsRatePlan["rateType"] {
  return value === "non_refundable" || value === "package" || value === "manual"
    ? value
    : "flexible";
}

function toMoney(value: unknown): PmsMoney {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    return {
      amountDecimal: toDecimalString(raw.amountDecimal ?? "0"),
      currency: typeof raw.currency === "string" ? raw.currency : "EUR",
    };
  }
  return { amountDecimal: "0", currency: "EUR" };
}

function isJsonScalar(value: unknown): value is PmsJsonScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function toDecimalString(value: string | number | unknown): string {
  if (typeof value === "number") return value.toFixed(2);
  if (typeof value !== "string") return "0.00";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : value;
}

function toInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
