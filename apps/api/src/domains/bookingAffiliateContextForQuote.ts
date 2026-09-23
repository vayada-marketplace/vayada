import type pg from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve only a live context with an admitted click for the quote's canonical hotel. */
export async function readBookingAffiliateContextForQuote(
  pool: Pick<pg.Pool, "query">,
  slug: string,
  contextId: string,
): Promise<string | null> {
  if (!uuid.test(contextId)) return null;
  const result = await pool.query(
    `SELECT context.id
     FROM booking.affiliate_click_contexts context
     JOIN hotel_catalog.property_slugs hotel
       ON hotel.property_id=context.property_id
      AND hotel.slug=$2 AND hotel.locale IS NULL
      AND hotel.purpose='canonical' AND hotel.status='active'
     WHERE context.id=$1 AND context.synthetic=FALSE
       AND EXISTS (
         SELECT 1 FROM booking.affiliate_click_admissions admission
         WHERE admission.context_id=context.id
           AND admission.admitted_at > clock_timestamp() - interval '90 days'
       )`,
    [contextId, slug],
  );
  return result.rowCount ? contextId.toLowerCase() : null;
}
