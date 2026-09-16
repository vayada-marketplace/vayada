import {
  readLegacyOwnershipTargetRow,
  type AdoptionQueryClient,
} from "./channexAdoptionTargetRows.js";
import {
  compareLegacyOwnershipBeforeState,
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
  type LegacyOwnershipDriftResult,
} from "./legacyOwnershipBeforeState.js";

/**
 * Read-only target drift evidence, NOT full ownership verification.
 * Caller must supply a dedicated client already in its transaction and take
 * ownership/claim locks before calling. No transaction is started or committed
 * here. Signed expected evidence, competing owners, source provenance, current
 * identity and eligibility must be verified by the consuming verifier separately.
 * Database/normalization errors propagate: they must never become unchanged.
 */
export async function readLegacyOwnershipDrift(
  client: AdoptionQueryClient,
  expected: readonly LegacyOwnershipFingerprint[],
): Promise<LegacyOwnershipDriftResult> {
  const shape = compareLegacyOwnershipBeforeState(expected, expected);
  if (shape.outcome === "blocked") return shape;
  const observed: LegacyOwnershipFingerprint[] = [];
  // Stable order on a single transaction client, independent of manifest ordering.
  for (const kind of Object.keys(LEGACY_OWNERSHIP_ROW_TABLES) as Array<
    keyof typeof LEGACY_OWNERSHIP_ROW_TABLES
  >) {
    const row = expected.find((item) => item.kind === kind)!;
    const table = LEGACY_OWNERSHIP_ROW_TABLES[kind];
    const actual = await readLegacyOwnershipTargetRow(client, table, row.id);
    observed.push({ kind, table, ...actual });
  }
  return compareLegacyOwnershipBeforeState(expected, observed);
}
