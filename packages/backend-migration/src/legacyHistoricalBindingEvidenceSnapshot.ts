import type pg from "pg";
import {
  evaluateLegacyHistoricalBinding,
  type LegacyHistoricalBindingExpected,
} from "./legacyHistoricalBindingPreflight.js";
import {
  readLegacyHistoricalBindingSourceProof,
  type LegacyHistoricalBindingSourceRequest,
} from "./legacyHistoricalBindingSourceProof.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";

export type LegacyHistoricalBindingEvidenceRequest = {
  sourceRequest: LegacyHistoricalBindingSourceRequest;
  bindingExpected: LegacyHistoricalBindingExpected;
  property: { id: string; rowStateSha256: string };
};

/**
 * Diagnostic assembly only. Caller independently authenticates the entire
 * expected input and configures both pools; no authority is established here.
 * Readers own separate snapshots, not a combined transaction or executor lock.
 */
export async function readLegacyHistoricalBindingEvidenceSnapshot(
  pools: { source: Pick<pg.Pool, "connect">; target: Pick<pg.Pool, "connect"> },
  request: LegacyHistoricalBindingEvidenceRequest,
) {
  const expected = structuredClone(request);
  const { sourceRequest, bindingExpected, property } = expected;
  const deny = (reason: string) =>
    Object.freeze({ outcome: "blocked" as const, reason, executable: false as const });
  // Empty observations exercise only existing expected-input/protected-key
  // validation. They are never presented as source proof or returned as evidence.
  const validation = evaluateLegacyHistoricalBinding(bindingExpected, {
    sourceRunId: "",
    sourceConnections: [],
    claims: [],
    connections: [],
  });
  if (
    validation.outcome === "blocked" &&
    ["invalid_expected", "protected_fixture"].includes(validation.reason)
  )
    return deny(validation.reason);
  if (
    sourceRequest.sourceRunId !== bindingExpected.sourceRunId ||
    (["id", "hotelId", "externalPropertyId", "rowOrdinal", "rowChecksumSha256"] as const).some(
      (key) => sourceRequest.source[key] !== bindingExpected.source[key],
    ) ||
    property.id !== bindingExpected.propertyId ||
    !/^[0-9a-f]{64}$/.test(property.rowStateSha256)
  )
    return deny("inconsistent_expected");

  const source = await readLegacyHistoricalBindingSourceProof(pools.source, sourceRequest);
  const target = await readLegacyHistoricalBindingTargetSnapshot(pools.target, {
    propertyId: bindingExpected.propertyId,
    externalPropertyId: bindingExpected.source.externalPropertyId,
  });
  const observations = Object.freeze({ source, target });
  const assessment =
    target.property.id !== property.id || target.property.rowStateSha256 !== property.rowStateSha256
      ? { outcome: "blocked" as const, reason: "property_mismatch" }
      : evaluateLegacyHistoricalBinding(bindingExpected, {
          ...source,
          claims: target.claims,
          connections: target.connections,
        });
  return Object.freeze({ ...assessment, executable: false as const, observations });
}
