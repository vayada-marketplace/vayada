type Fingerprint = { id: string; rowStateSha256: string };
type SourceConnection = {
  id: string;
  hotelId: string;
  externalPropertyId: string;
  rowOrdinal: number;
  rowChecksumSha256: string;
  active: boolean | null;
};
export type LegacyHistoricalBindingExpected = {
  sourceRunId: string;
  source: Omit<SourceConnection, "active">;
  propertyId: string;
  claim: Fingerprint;
  connections: readonly Fingerprint[];
};
export type LegacyHistoricalBindingObserved = {
  sourceRunId: string;
  sourceConnections: readonly SourceConnection[];
  claims: readonly (Fingerprint & {
    propertyId: string;
    provider: string;
    externalPropertyId: string;
    claimState: string;
    claimSource: string;
  })[];
  connections: readonly (Fingerprint & {
    propertyId: string;
    provider: string;
    connectionStatus: string;
    externalPropertyId: string | null;
    legacyExternalPropertyId: string | null;
    migrationRunId: string | null;
  })[];
};
type BlockReason =
  | "invalid_expected"
  | "protected_fixture"
  | "source_mismatch"
  | "source_inactive_requires_explicit_disposition"
  | "claim_mismatch"
  | "connection_mismatch";
type Result =
  | { outcome: "supplied_binding_matches_requires_owner_eligibility" }
  | { outcome: "blocked"; reason: BlockReason };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const protectedKeys = new Set([
  "17621565-40b5-4ebc-8727-3a301ac947a2", // Next-native import QA property/external
  "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
  "65f6b2fc-c783-4963-9d6b-a85f82319769", // shared staging property/external
  "8f4c1e47-3de1-4150-8bde-ad031a013842",
]);

/**
 * Pure supplied-data comparison, NOT proof, approval or an executable transition.
 * Future reader must verify provenance/hashes and exhaustive OR-key row sets;
 * future consumer must verify owner eligibility and repeat evidence under locks.
 * No caller-controlled flag can turn this result into verified database facts.
 */
export function evaluateLegacyHistoricalBinding(
  expected: LegacyHistoricalBindingExpected,
  observed: LegacyHistoricalBindingObserved,
): Result {
  const blocked = (reason: BlockReason): Result => ({ outcome: "blocked", reason });
  const source = expected.source;
  const fingerprints = [expected.claim, ...expected.connections];
  if (
    !/^vay1351-[0-9a-f]{24}$/.test(expected.sourceRunId) ||
    ![source.id, source.hotelId, source.externalPropertyId, expected.propertyId].every((id) =>
      UUID.test(id),
    ) ||
    !Number.isSafeInteger(source.rowOrdinal) ||
    source.rowOrdinal < 1 ||
    !SHA.test(source.rowChecksumSha256) ||
    expected.connections.length === 0 ||
    fingerprints.some((row) => !UUID.test(row.id) || !SHA.test(row.rowStateSha256)) ||
    new Set(expected.connections.map((row) => row.id)).size !== expected.connections.length
  )
    return blocked("invalid_expected");
  if (
    [source.hotelId, source.externalPropertyId, expected.propertyId].some((id) =>
      protectedKeys.has(id),
    )
  )
    return blocked("protected_fixture");
  const original = observed.sourceConnections[0];
  if (
    observed.sourceRunId !== expected.sourceRunId ||
    observed.sourceConnections.length !== 1 ||
    !original ||
    original.id !== source.id ||
    original.hotelId !== source.hotelId ||
    original.externalPropertyId !== source.externalPropertyId ||
    original.rowOrdinal !== source.rowOrdinal ||
    original.rowChecksumSha256 !== source.rowChecksumSha256 ||
    (original.active !== true && original.active !== false)
  )
    return blocked("source_mismatch");
  if (original.active === false) return blocked("source_inactive_requires_explicit_disposition");
  const claim = observed.claims[0];
  if (
    observed.claims.length !== 1 ||
    !claim ||
    claim.id !== expected.claim.id ||
    claim.rowStateSha256 !== expected.claim.rowStateSha256 ||
    claim.propertyId !== expected.propertyId ||
    claim.provider !== "channex" ||
    claim.externalPropertyId !== source.externalPropertyId ||
    claim.claimState !== "historical" ||
    claim.claimSource !== "migration"
  )
    return blocked("claim_mismatch");
  if (
    observed.connections.length !== expected.connections.length ||
    expected.connections.some((fingerprint) => {
      const matches = observed.connections.filter((row) => row.id === fingerprint.id);
      const row = matches[0];
      return (
        matches.length !== 1 ||
        !row ||
        row.rowStateSha256 !== fingerprint.rowStateSha256 ||
        row.propertyId !== expected.propertyId ||
        row.provider !== "channex" ||
        row.connectionStatus !== "disconnected" ||
        row.externalPropertyId !== null ||
        row.legacyExternalPropertyId !== source.externalPropertyId ||
        row.migrationRunId !== expected.sourceRunId
      );
    })
  )
    return blocked("connection_mismatch");
  return { outcome: "supplied_binding_matches_requires_owner_eligibility" };
}
