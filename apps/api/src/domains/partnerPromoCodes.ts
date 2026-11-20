import pg from "pg";

import {
  checkPromoFixedAmountStep,
  type CreateBookingPromoCodeBody,
  type UpdateBookingPromoCodeBody,
} from "../routes/bookingPromoCodes.js";

/**
 * VAY-2437: a connected partner app's own promo codes at one hotel (booking.promo_definitions rows
 * with its partner_client_id, migration 0545). The partner sees and changes only these; they are
 * retired, never deleted. The hotel sees them on its Promos page but can't change them there.
 */
export type PartnerPromoCode = {
  promoCodeId: string;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  maxUses: number;
  currentUses: number;
  isActive: boolean;
  status: "active" | "retired";
  validFrom: string | null;
  validUntil: string | null;
  stayDateFrom: string | null;
  stayDateUntil: string | null;
  minBookingValue: string | null;
  applicableRoomIds: string[] | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PartnerPromoCodeScope = { appId: string; propertyId: string };

export type PartnerPromoCodesRepository = {
  list(scope: PartnerPromoCodeScope): Promise<PartnerPromoCode[]>;
  find(scope: PartnerPromoCodeScope, promoCodeId: string): Promise<PartnerPromoCode | null>;
  create(
    scope: PartnerPromoCodeScope,
    body: CreateBookingPromoCodeBody & { externalId: string | null },
  ): Promise<PartnerPromoCode>;
  /** Null when the code isn't this app's at this hotel, or is retired. */
  update(
    scope: PartnerPromoCodeScope,
    promoCodeId: string,
    body: Omit<UpdateBookingPromoCodeBody, "code"> & { externalId?: string | null },
  ): Promise<PartnerPromoCode | null>;
  retire(
    scope: PartnerPromoCodeScope,
    promoCodeId: string,
  ): Promise<"retired" | "already_retired" | "not_found">;
  close?(): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = (source: string) => `SELECT
    promo.id::text AS "promoCodeId", promo.code, promo.discount_type AS "discountType",
    promo.discount_value::text AS "discountValue", promo.max_uses AS "maxUses",
    promo.current_uses AS "currentUses", promo.is_active AS "isActive", promo.status,
    to_char(promo.valid_from, 'YYYY-MM-DD') AS "validFrom",
    to_char(promo.valid_until, 'YYYY-MM-DD') AS "validUntil",
    to_char(promo.stay_date_from, 'YYYY-MM-DD') AS "stayDateFrom",
    to_char(promo.stay_date_until, 'YYYY-MM-DD') AS "stayDateUntil",
    promo.min_booking_value::text AS "minBookingValue",
    promo.applicable_room_ids::text[] AS "applicableRoomIds",
    promo.external_id AS "externalId", promo.created_at AS "createdAt",
    promo.updated_at AS "updatedAt"
  FROM ${source} promo`;

type Row = Omit<PartnerPromoCode, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

const toCode = (row: Row): PartnerPromoCode => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function createPgPartnerPromoCodesRepository(config: {
  connectionString?: string;
  pool?: pg.Pool;
  max?: number;
}): PartnerPromoCodesRepository {
  const ownsPool = !config.pool;
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Partner promo codes repository needs a connection string");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  async function find(scope: PartnerPromoCodeScope, promoCodeId: string) {
    if (!UUID.test(promoCodeId)) return null;
    const result = await pool.query<Row>(
      `${SELECT("booking.promo_definitions")}
       WHERE promo.id = $3::uuid AND promo.property_id = $2::uuid
         AND promo.partner_client_id = $1::uuid`,
      [scope.appId, scope.propertyId, promoCodeId],
    );
    return result.rows[0] ? toCode(result.rows[0]) : null;
  }

  return {
    async list(scope) {
      const result = await pool.query<Row>(
        `${SELECT("booking.promo_definitions")}
         WHERE promo.property_id = $2::uuid AND promo.partner_client_id = $1::uuid
         ORDER BY promo.created_at, promo.id`,
        [scope.appId, scope.propertyId],
      );
      return result.rows.map(toCode);
    },

    find,

    async create(scope, body) {
      await checkPromoFixedAmountStep(pool, scope.propertyId, null, body);
      const result = await pool.query<Row>(
        `WITH inserted AS (
           INSERT INTO booking.promo_definitions (
             property_id, code, discount_type, discount_value, min_booking_value,
             applicable_room_ids, valid_from, valid_until, stay_date_from, stay_date_until,
             is_active, max_uses, partner_client_id, external_id
           )
           VALUES ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6::uuid[], $7::date, $8::date,
                   $9::date, $10::date, $11, $12, $13::uuid, $14)
           RETURNING *
         )
         ${SELECT("inserted")}`,
        [
          scope.propertyId,
          body.code,
          body.discountType,
          body.discountValue,
          body.minBookingValue,
          body.applicableRoomIds,
          body.validFrom,
          body.validUntil,
          body.stayDateFrom,
          body.stayDateUntil,
          body.isActive,
          body.maxUses,
          scope.appId,
          body.externalId,
        ],
      );
      return toCode(result.rows[0]!);
    },

    async update(scope, promoCodeId, body) {
      if (!UUID.test(promoCodeId)) return null;
      await checkPromoFixedAmountStep(pool, scope.propertyId, promoCodeId, body);
      const values: unknown[] = [scope.appId, scope.propertyId, promoCodeId];
      const sets: string[] = [];
      const set = (column: string, value: unknown, cast = "") => {
        if (value === undefined) return;
        values.push(value);
        sets.push(`${column} = $${values.length}${cast}`);
      };
      set("discount_type", body.discountType);
      set("discount_value", body.discountValue, "::numeric");
      set("min_booking_value", body.minBookingValue, "::numeric");
      set("applicable_room_ids", body.applicableRoomIds, "::uuid[]");
      set("valid_from", body.validFrom, "::date");
      set("valid_until", body.validUntil, "::date");
      set("stay_date_from", body.stayDateFrom, "::date");
      set("stay_date_until", body.stayDateUntil, "::date");
      set("is_active", body.isActive);
      set("max_uses", body.maxUses);
      set("external_id", body.externalId);
      sets.push("updated_at = now()");
      const result = await pool.query<Row>(
        `WITH updated AS (
           UPDATE booking.promo_definitions
           SET ${sets.join(", ")}
           WHERE id = $3::uuid AND property_id = $2::uuid AND partner_client_id = $1::uuid
             AND status <> 'retired'
           RETURNING *
         )
         ${SELECT("updated")}`,
        values,
      );
      return result.rows[0] ? toCode(result.rows[0]) : null;
    },

    async retire(scope, promoCodeId) {
      if (!UUID.test(promoCodeId)) return "not_found";
      const result = await pool.query<{ retired: boolean }>(
        `WITH target AS (
           SELECT id, status FROM booking.promo_definitions
           WHERE id = $3::uuid AND property_id = $2::uuid AND partner_client_id = $1::uuid
         ), retired AS (
           UPDATE booking.promo_definitions promo
           SET status = 'retired', is_active = false, updated_at = now()
           FROM target WHERE promo.id = target.id AND target.status <> 'retired'
           RETURNING promo.id
         )
         SELECT EXISTS (SELECT 1 FROM retired) AS retired FROM target`,
        [scope.appId, scope.propertyId, promoCodeId],
      );
      const row = result.rows[0];
      return !row ? "not_found" : row.retired ? "retired" : "already_retired";
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
