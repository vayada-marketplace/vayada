type BookingPublicationLockClient = {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
};

/** Coordinates every mutation that can change a property's public Booking publication. */
export async function lockBookingPublication(
  client: BookingPublicationLockClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('booking.publication'),
       hashtext($1::uuid::text)
     )`,
    [propertyId],
  );
}
