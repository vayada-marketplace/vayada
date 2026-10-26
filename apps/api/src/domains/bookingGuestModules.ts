import type { QueryResult, QueryResultRow } from "pg";

/** What guests get of the Feature Hub Add-ons and Promos switches (VAY-2200). Both are read live,
 * outside the booking page publication. Add-ons also needs the Add-ons page's "show the step"
 * choice. A property without booking settings keeps both on. */
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
    `SELECT addons_enabled AND show_addons_step AS "addOns", promo_codes_enabled AS "promoCodes"
     FROM booking.booking_settings WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? { addOns: true, promoCodes: true };
}

/** Whether guests can enter promo codes: the hotel's Promos switch, read live by both public hotel
 * profile reads. A property without booking settings keeps them on. */
export const LIVE_PROMO_CODES_SQL = (propertyId: string) =>
  `COALESCE((SELECT promo_codes_enabled FROM booking.booking_settings
             WHERE property_id = ${propertyId}), TRUE)`;
