import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import type { OwnerBootstrapObservation } from "./legacyOwnerBootstrapPlan.js";

type Owner = { ownerId: string; email: string };
type TargetObservation = Pick<OwnerBootstrapObservation, "ownerId" | "target">;

// ECMAScript trim whitespace, explicitly shared with PostgreSQL btrim.
const trimCharacters =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

// Every candidate is bounded by one of eight IDs/contact values. Return counts
// and classifications only, never contact data or unrelated candidate IDs.
const sql = `WITH wanted AS (
  SELECT * FROM unnest($1::uuid[], $2::text[]) AS w(owner_id,email)
), candidates AS (
  SELECT w.owner_id,u.id,u.status,lower(btrim(u.email,$3))=w.email AS email_matches
  FROM wanted w JOIN identity.users u
    ON u.id=w.owner_id OR lower(btrim(u.email,$3))=w.email
)
SELECT w.owner_id::text AS "ownerId",
  (SELECT count(*)::int FROM candidates c WHERE c.owner_id=w.owner_id) AS "candidateCount",
  (SELECT count(*)::int FROM candidates c WHERE c.owner_id=w.owner_id
    AND c.id=w.owner_id AND c.email_matches) AS "exactCount",
  EXISTS(SELECT 1 FROM candidates c WHERE c.owner_id=w.owner_id
    AND c.status NOT IN ('active','pending')) AS restricted,
  EXISTS(SELECT 1 FROM identity.external_identities e WHERE e.provider='workos'
    AND lower(btrim(e.provider_email,$3))=w.email AND e.user_id<>w.owner_id)
    OR (SELECT count(*) FROM identity.external_identities e WHERE e.provider='workos'
      AND e.user_id=w.owner_id AND e.provider_user_id IS NOT NULL)>1 AS "identityConflict"
FROM wanted w ORDER BY w.owner_id`;

/**
 * Diagnostic only. Caller owns an independently environment-verified connection,
 * full visibility of these target tables, and a READ ONLY transaction. The eight
 * source IDs/emails must already be authorized and source-bound. This reads no
 * source database, provider, ownership links or entitlements and grants nothing.
 * Never log SQL parameters. Returned observations are NOT a complete planner input.
 */
export async function readLegacyOwnerBootstrapTargets(
  client: AdoptionQueryClient,
  owners: readonly Owner[],
): Promise<TargetObservation[]> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !Array.isArray(owners) ||
    owners.length !== 8 ||
    owners.some(
      (owner) =>
        !owner ||
        !uuid.test(owner.ownerId) ||
        typeof owner.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email.trim()) ||
        owner.email.length > 254,
    )
  )
    throw new Error("INVALID_OWNER_TARGET_SCOPE");
  // Copy before the first await; caller mutation cannot expand the query scope.
  const ids = owners.map((owner) => owner.ownerId);
  const emails = owners.map((owner) => owner.email.trim().toLowerCase());
  if (new Set(ids).size !== 8 || new Set(emails).size !== 8)
    throw new Error("DUPLICATE_OWNER_TARGET_SCOPE");
  try {
    const setting = await client.query("SHOW transaction_read_only");
    if (setting.rows[0]?.transaction_read_only !== "on") throw new Error();
    const { rows } = await client.query<{
      ownerId: string;
      candidateCount: number;
      exactCount: number;
      restricted: boolean;
      identityConflict: boolean;
    }>(sql, [ids, emails, trimCharacters]);
    if (
      rows.length !== 8 ||
      new Set(rows.map((row) => row.ownerId)).size !== 8 ||
      rows.some(
        (row) =>
          !ids.includes(row.ownerId) ||
          !Number.isSafeInteger(row.candidateCount) ||
          row.candidateCount < 0 ||
          !Number.isSafeInteger(row.exactCount) ||
          row.exactCount < 0 ||
          row.exactCount > 1 ||
          row.exactCount > row.candidateCount ||
          typeof row.restricted !== "boolean" ||
          typeof row.identityConflict !== "boolean",
      )
    )
      throw new Error();
    return rows.map((row) => ({
      ownerId: row.ownerId,
      target: row.identityConflict
        ? "conflict"
        : row.restricted
          ? "restricted"
          : row.candidateCount === 0
            ? "absent"
            : row.candidateCount === 1 && row.exactCount === 1
              ? "exact"
              : "conflict",
    }));
  } catch {
    // A database error can include sensitive bind parameters. Do not propagate it.
    throw new Error("OWNER_TARGET_READ_FAILED");
  }
}
