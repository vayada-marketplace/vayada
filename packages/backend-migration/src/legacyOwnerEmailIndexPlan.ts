import { createHash } from "node:crypto";

// PostgreSQL convert_to/textsend are STABLE, not index-expression IMMUTABLE.
// Decode escaped backslashes to preserve the UTF8 database's exact text bytes
// using native immutable functions. The caller must verify server_encoding=UTF8.
const normalized = `lower(btrim(email, U&'\\0009\\000a\\000b\\000c\\000d\\0020\\00a0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200a\\2028\\2029\\202f\\205f\\3000\\feff') COLLATE "C")`;
export const OWNER_EMAIL_INDEX_EXPRESSION = `encode(sha256(decode(replace(${normalized}, chr(92), chr(92)||chr(92)), 'escape')), 'hex')`;

/** SQL proposal only. No executor, database call, approval or account linking. */
export function planLegacyOwnerEmailIndex(emailSha256: readonly string[]) {
  const scope = Array.isArray(emailSha256) ? [...emailSha256] : [];
  if (
    scope.length !== 8 ||
    scope.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(scope).size !== 8
  )
    throw new Error("INVALID_OWNER_EMAIL_GUARD_SCOPE");
  const hashes = scope.sort();
  const scopeSha256 = createHash("sha256")
    .update(`vayada:legacy-owner-email-index:v1\0${hashes.join("\n")}`)
    .digest("hex");
  const indexName = `legacy_owner_email_guard_${scopeSha256.slice(0, 24)}`;
  return {
    indexName,
    scopeSha256,
    executable: false as const,
    sql: `CREATE UNIQUE INDEX ${indexName} ON identity.users ((${OWNER_EMAIL_INDEX_EXPRESSION}))
WHERE ${OWNER_EMAIL_INDEX_EXPRESSION} IN (${hashes.map((hash) => `'${hash}'`).join(",")})`,
  };
}
