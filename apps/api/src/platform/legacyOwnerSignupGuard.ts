import type pg from "pg";

// A bootstrap receipt is a deny marker, never linking or access authority.
export async function assertNotBootstrapProtectedUser(
  client: pg.PoolClient,
  userId: string,
): Promise<void> {
  let allowed = false;
  try {
    const result = await client.query<{ protected: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM platform.legacy_owner_bootstrap_receipts
         WHERE $1::uuid = ANY(owner_user_ids)
       ) AS protected`,
      [userId],
    );
    allowed = result.rows.length === 1 && result.rows[0]?.protected === false;
  } catch {
    // Missing schema/privilege is not an empty registry. Keep errors PII-free.
  }
  if (!allowed) throw new Error("Legacy owner account reconciliation required");
}
