import type pg from "pg";

type SyntheticBooking = {
  id: string;
  propertyId: string;
  contextId: string;
  publicReference: string;
  checkIn: string;
  checkOut: string;
  currency: string;
};

/** Test-only Booking insert. The context lock precedes the original reservation insert. */
export async function createSyntheticAffiliateOriginalBooking(
  client: pg.PoolClient,
  booking: SyntheticBooking,
): Promise<{ historyCutoff: string; replayed: boolean }> {
  // A caller-owned READ COMMITTED transaction retains the context lock through commit.
  await client.query("SAVEPOINT affiliate_original_binding_guard");
  await client.query("RELEASE SAVEPOINT affiliate_original_binding_guard");
  if (
    (await client.query("SHOW transaction_isolation")).rows[0]?.transaction_isolation !==
    "read committed"
  )
    throw new Error("Affiliate original binding requires READ COMMITTED");

  const context = await client.query(
    `SELECT id FROM booking.affiliate_click_contexts
     WHERE id=$1 AND property_id=$2 AND synthetic=TRUE FOR UPDATE`,
    [booking.contextId, booking.propertyId],
  );
  if (!context.rowCount) throw new Error("Synthetic affiliate context is unavailable");

  const inserted = await client.query(
    `INSERT INTO booking.guest_bookings
       (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
     VALUES ($1,$2,$3,'draft',$4,$5,$6)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [
      booking.id,
      booking.propertyId,
      booking.publicReference,
      booking.checkIn,
      booking.checkOut,
      booking.currency,
    ],
  );
  if (!inserted.rowCount) {
    const prior = await client.query(
      `SELECT b.context_id,b.history_cutoff,
              b.original_public_reference=$3 AND b.original_check_in=$4
                AND b.original_check_out=$5 AND b.original_currency=$6 AS matches_booking
       FROM booking.affiliate_original_booking_bindings b
       WHERE b.booking_id=$1 AND b.property_id=$2`,
      [
        booking.id,
        booking.propertyId,
        booking.publicReference,
        booking.checkIn,
        booking.checkOut,
        booking.currency,
      ],
    );
    if (!prior.rowCount)
      throw new Error("Original booking already exists without affiliate binding");
    if (prior.rows[0].context_id !== booking.contextId)
      throw new Error("Original booking already has another affiliate context");
    if (!prior.rows[0].matches_booking)
      throw new Error("Original booking request differs from stored reservation");
    return { historyCutoff: String(prior.rows[0].history_cutoff), replayed: true };
  }

  const result = await client.query(
    `INSERT INTO booking.affiliate_original_booking_bindings
       (booking_id,property_id,context_id,history_cutoff,
        original_public_reference,original_check_in,original_check_out,original_currency,synthetic)
     SELECT $1,$2,$3,COALESCE(MAX(history_position),0),$4,$5,$6,$7,TRUE
     FROM booking.affiliate_click_admissions WHERE context_id=$3
     RETURNING history_cutoff`,
    [
      booking.id,
      booking.propertyId,
      booking.contextId,
      booking.publicReference,
      booking.checkIn,
      booking.checkOut,
      booking.currency,
    ],
  );
  return { historyCutoff: String(result.rows[0].history_cutoff), replayed: false };
}
