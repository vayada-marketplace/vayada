import type pg from "pg";

// A receipt denies access; it cannot authorize a grant or release.
export async function assertSubjectNotBootstrapProtected(client: pg.PoolClient, userId: string) {
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
    // Unreadable storage must not become an empty registry or expose DB details.
  }
  if (!allowed) throw new Error("Legacy owner account reconciliation required");
}
