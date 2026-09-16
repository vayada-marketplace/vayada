/**
 * Drift check only: expected fingerprints must come from authenticated,
 * evidence-bound approvals; observed fingerprints must be freshly read under
 * the consuming transaction's locks. This does not authenticate either input,
 * prove ownership, validate status eligibility or authorize a write/access.
 * Complete competing-owner enumeration remains the reader's responsibility.
 */
export const LEGACY_OWNERSHIP_ROW_TABLES = {
  user: "identity.users",
  membership: "identity.organization_memberships",
  organization: "identity.organizations",
  property: "hotel_catalog.properties",
  sourceLink: "hotel_catalog.property_source_links",
  legacyLink: "identity.organization_resource_links",
  canonicalLink: "identity.organization_resource_links",
  pmsLink: "identity.organization_resource_links",
} as const;

export type LegacyOwnershipRowKind = keyof typeof LEGACY_OWNERSHIP_ROW_TABLES;
export type LegacyOwnershipFingerprint = {
  kind: LegacyOwnershipRowKind;
  table: string;
  id: string;
  /** Existing hashTargetRow/readAdoptionTargetRow format; never hash a partial row. */
  rowStateSha256: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type LegacyOwnershipDriftResult =
  | { outcome: "unchanged" }
  | { outcome: "blocked"; reason: "invalid_expected" | "invalid_observed" | "target_drift" };

export function compareLegacyOwnershipBeforeState(
  expected: readonly LegacyOwnershipFingerprint[],
  observed: readonly LegacyOwnershipFingerprint[],
): LegacyOwnershipDriftResult {
  const expectedRows = indexRows(expected);
  if (!expectedRows) return { outcome: "blocked", reason: "invalid_expected" };
  const observedRows = indexRows(observed);
  if (!observedRows) return { outcome: "blocked", reason: "invalid_observed" };
  for (const [kind, row] of expectedRows) {
    const actual = observedRows.get(kind)!;
    if (actual.id !== row.id || actual.rowStateSha256 !== row.rowStateSha256)
      return { outcome: "blocked", reason: "target_drift" };
  }
  return { outcome: "unchanged" };
}

function indexRows(
  rows: readonly LegacyOwnershipFingerprint[],
): Map<LegacyOwnershipRowKind, LegacyOwnershipFingerprint> | null {
  if (!Array.isArray(rows) || rows.length !== Object.keys(LEGACY_OWNERSHIP_ROW_TABLES).length)
    return null;
  const indexed = new Map<LegacyOwnershipRowKind, LegacyOwnershipFingerprint>();
  const identities = new Set<string>();
  for (const row of rows as readonly LegacyOwnershipFingerprint[]) {
    if (
      !row ||
      !Object.hasOwn(LEGACY_OWNERSHIP_ROW_TABLES, row.kind) ||
      row.table !== LEGACY_OWNERSHIP_ROW_TABLES[row.kind] ||
      typeof row.id !== "string" ||
      !UUID.test(row.id) ||
      typeof row.rowStateSha256 !== "string" ||
      !SHA256.test(row.rowStateSha256) ||
      indexed.has(row.kind) ||
      identities.has(`${row.table}:${row.id}`)
    )
      return null;
    indexed.set(row.kind, row);
    identities.add(`${row.table}:${row.id}`);
  }
  return indexed;
}
