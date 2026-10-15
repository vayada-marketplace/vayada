import type { QueryResult, QueryResultRow } from "pg";

/** What guests get of the Feature Hub Add-ons and Promos switches (VAY-2200). Both are read live,
 * outside the booking page publication. A property without booking settings keeps both on. */
export type GuestModuleSwitches = { addOns: boolean; promoCodes: boolean };

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export async function readGuestModuleSwitches(
  db: Queryable,
  propertyId: string,
): Promise<GuestModuleSwitches> {
  const result = await db.query<GuestModuleSwitches>(
    `SELECT show_addons_step AS "addOns", promo_codes_enabled AS "promoCodes"
     FROM booking.booking_settings WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? { addOns: true, promoCodes: true };
}

/** Whether guests can use a promo code now: the Promos switch is on and a code is live. Shared by
 * both public hotel profile reads, so a code created after publishing shows the field at once. */
export const LIVE_PROMO_CODES_SQL = (propertyId: string) => `(
  COALESCE((SELECT promo_codes_enabled FROM booking.booking_settings
            WHERE property_id = ${propertyId}), TRUE)
  AND EXISTS (SELECT 1 FROM booking.promo_definitions promo
    WHERE promo.property_id = ${propertyId} AND promo.status = 'active' AND promo.is_active
      AND (promo.valid_from IS NULL OR promo.valid_from <= current_date)
      AND (promo.valid_until IS NULL OR promo.valid_until >= current_date)))`;
