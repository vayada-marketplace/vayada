import type { PoolClient } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hold the context lock through the caller's original-booking transaction. */
export async function lockLiveAffiliateContextForOriginal(
  client: PoolClient,
  propertyId: string,
  contextId: string | undefined,
): Promise<boolean> {
  if (!contextId || !uuid.test(contextId)) return false;
  await client.query("SAVEPOINT affiliate_live_original_lock");
  try {
    if (
      (await client.query("SHOW transaction_isolation")).rows[0]?.transaction_isolation !==
      "read committed"
    )
      throw new Error("Affiliate original binding requires READ COMMITTED");
    const result = await client.query(
      `SELECT 1 FROM booking.affiliate_click_contexts context
       WHERE context.id=$1 AND context.property_id=$2 AND context.synthetic=FALSE
       FOR UPDATE OF context`,
      [contextId, propertyId],
    );
    // Recheck after acquiring the lock: a last admission may have aged out
    // while another request held the context row.
    const recent = result.rowCount
      ? await client.query(
          `SELECT 1 FROM booking.affiliate_click_admissions
           WHERE context_id=$1 AND admitted_at > clock_timestamp() - interval '90 days'
           LIMIT 1`,
          [contextId],
        )
      : null;
    await client.query("RELEASE SAVEPOINT affiliate_live_original_lock");
    return Boolean(recent?.rowCount);
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT affiliate_live_original_lock");
    await client.query("RELEASE SAVEPOINT affiliate_live_original_lock");
    return false;
  }
}

/** Failure leaves the original booking unbound, never partially bound. */
export async function bindLiveAffiliateOriginal(
  client: PoolClient,
  booking: {
    id: string;
    contextId: string;
  },
): Promise<boolean> {
  await client.query("SAVEPOINT affiliate_live_original_insert");
  try {
    const bound = await client.query(
      "SELECT booking.bind_live_affiliate_original($1,$2) AS bound",
      [booking.id, booking.contextId],
    );
    await client.query("RELEASE SAVEPOINT affiliate_live_original_insert");
    return bound.rows[0]?.bound === true;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT affiliate_live_original_insert");
    await client.query("RELEASE SAVEPOINT affiliate_live_original_insert");
    return false;
  }
}
