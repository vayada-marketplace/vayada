import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { planLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexPlan.js";

// Exact non-pretty pg_get_expr output for the reviewed SQL on PostgreSQL 16/17.
// Never strip whitespace or casts: whitespace inside the trim literal is data.
const trim =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const expression = `encode(sha256(decode(replace(lower(btrim(email, '${trim}'::text)), chr(92), (chr(92) || chr(92))), 'escape'::text)), 'hex'::text)`;

/**
 * Catalog snapshot check only; no DDL, locks, approval or account writes.
 * Caller must use SET LOCAL search_path = pg_catalog and retain an independently
 * authorized DDL-excluding table lock through any later write. A prior successful
 * observation is not authority or proof that the index still exists.
 */
export async function verifyLegacyOwnerEmailIndex(
  client: AdoptionQueryClient,
  emailSha256: readonly string[],
): Promise<{ indexName: string; scopeSha256: string; executable: false }> {
  const plan = planLegacyOwnerEmailIndex(emailSha256);
  const predicate = `(${expression} = ANY (ARRAY[${[...emailSha256]
    .sort()
    .map((hash) => `'${hash}'::text`)
    .join(", ")}]))`;
  try {
    const result = await client.query<{ valid: boolean }>(
      `SELECT (
        current_setting('search_path') = 'pg_catalog'
        AND current_setting('standard_conforming_strings') = 'on'
        AND current_setting('server_encoding') = 'UTF8'
        AND current_setting('server_version_num')::int BETWEEN 160000 AND 179999
        AND d.datcollversion IS NOT DISTINCT FROM pg_catalog.pg_database_collation_actual_version(d.oid)
        AND t.relkind = 'r' AND c.relkind = 'i' AND am.amname = 'btree'
        AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated = ''
        AND a.attcollation = 'pg_catalog.default'::pg_catalog.regcollation
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indimmediate AND NOT i.indisexclusion AND NOT i.indisprimary
        AND NOT i.indnullsnotdistinct
        AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indkey[0] = 0
        AND i.indoption[0] = 0
        AND i.indcollation[0] = 'pg_catalog.default'::pg_catalog.regcollation
        AND i.indclass[0] = (
          SELECT op.oid FROM pg_catalog.pg_opclass op
          JOIN pg_catalog.pg_namespace n ON n.oid = op.opcnamespace
          WHERE n.nspname = 'pg_catalog' AND op.opcname = 'text_ops' AND op.opcmethod = am.oid
        )
        AND pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false) = $2
        AND pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) = $3
      ) AS valid
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = 'email'
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
      JOIN pg_catalog.pg_database d ON d.datname = current_database()
      WHERE ns.nspname = 'identity' AND c.relname = $1
        AND tn.nspname = 'identity' AND t.relname = 'users'`,
      [plan.indexName, expression, predicate],
    );
    if (result.rows.length !== 1 || result.rows[0]?.valid !== true) throw new Error("mismatch");
  } catch {
    throw new Error("LEGACY_OWNER_EMAIL_INDEX_NOT_VERIFIED");
  }
  return { indexName: plan.indexName, scopeSha256: plan.scopeSha256, executable: false };
}
