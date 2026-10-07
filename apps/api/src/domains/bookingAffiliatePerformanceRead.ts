import pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export type AffiliateAttributedBooking = {
  agreementId: string;
  propertyId: string;
  bookingId: string;
};

export async function readAffiliateAttributedBookings(
  database: Queryable,
  input: {
    propertyIds: string[];
    agreementIds: string[];
    from?: string;
    to?: string;
    source?: string;
    campaign?: string;
  },
): Promise<AffiliateAttributedBooking[]> {
  const result = await database.query<AffiliateAttributedBooking>(
    `WITH candidates AS (
      SELECT binding.booking_id,binding.property_id,link.agreement_id,occurrence.source,
        occurrence.campaign_label,booking.created_at,row_number() OVER(PARTITION BY binding.booking_id
          ORDER BY admission.history_position DESC) AS winner
      FROM booking.affiliate_original_booking_bindings binding
      JOIN booking.guest_bookings booking ON booking.id=binding.booking_id AND booking.property_id=binding.property_id
      JOIN booking.affiliate_click_admissions admission ON admission.context_id=binding.context_id
        AND admission.history_position<=binding.history_cutoff
      JOIN marketplace.affiliate_click_occurrences occurrence ON occurrence.id=admission.click_id
      JOIN marketplace.affiliate_links link ON link.id=occurrence.link_id AND link.property_id=binding.property_id
      JOIN marketplace.affiliate_published_terms terms ON terms.id=occurrence.terms_id
      WHERE binding.synthetic=FALSE AND occurrence.synthetic=FALSE AND binding.property_id=ANY($1::uuid[])
        AND occurrence.clicked_at<=booking.created_at
        AND occurrence.clicked_at>=booking.created_at-
          make_interval(days=>(terms.disclosure::jsonb#>>'{terms,attributionWindowDays}')::int)
    ) SELECT agreement_id::text AS "agreementId",property_id::text AS "propertyId",
        booking_id::text AS "bookingId" FROM candidates
      WHERE winner=1 AND agreement_id=ANY($2::uuid[])
        AND ($3::timestamptz IS NULL OR created_at>=$3::timestamptz)
        AND ($4::timestamptz IS NULL OR created_at<$4::timestamptz)
        AND ($5::text IS NULL OR source=$5) AND ($6::text IS NULL OR campaign_label=$6)`,
    [
      input.propertyIds,
      input.agreementIds,
      input.from ?? null,
      input.to ?? null,
      input.source ?? null,
      input.campaign ?? null,
    ],
  );
  return result.rows;
}
