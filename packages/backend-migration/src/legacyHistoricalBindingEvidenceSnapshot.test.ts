import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLegacyHistoricalBindingEvidenceSnapshot as read,
  type LegacyHistoricalBindingEvidenceRequest,
} from "./legacyHistoricalBindingEvidenceSnapshot.js";
import { readLegacyHistoricalBindingSourceProof } from "./legacyHistoricalBindingSourceProof.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";

// Composition-only mocks: neither PostgreSQL evidence nor injected production services.
vi.mock("./legacyHistoricalBindingSourceProof.js");
vi.mock("./legacyHistoricalBindingTargetReader.js");
const sourceRead = vi.mocked(readLegacyHistoricalBindingSourceProof);
const targetRead = vi.mocked(readLegacyHistoricalBindingTargetSnapshot);
const pools = { source: { connect: vi.fn() }, target: { connect: vi.fn() } };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(offset = 0) {
  const source = {
    id: id(offset + 1),
    hotelId: id(offset + 2),
    externalPropertyId: id(offset + 3),
    rowOrdinal: 1,
    rowChecksumSha256: "a".repeat(64),
  };
  const sourceRunId = `vay1351-${"a".repeat(24)}`;
  const claim = { id: id(offset + 4), rowStateSha256: "b".repeat(64) };
  const connection = { id: id(offset + 5), rowStateSha256: "c".repeat(64) };
  const request: LegacyHistoricalBindingEvidenceRequest = {
    sourceRequest: {
      sourceRunId,
      sourceEnvironment: "local",
      sourceSchemaRevision: "d".repeat(40),
      sourceEvidenceSha256: "e".repeat(64),
      snapshotIdentifierSha256: "f".repeat(64),
      source,
    },
    bindingExpected: {
      sourceRunId,
      source: { ...source },
      propertyId: id(offset + 6),
      claim,
      connections: [connection],
    },
    property: { id: id(offset + 6), rowStateSha256: "1".repeat(64) },
  };
  const sourceResult = { sourceRunId, sourceConnections: [{ ...source, active: true }] };
  const target = {
    property: { ...request.property, profileStatus: "draft" },
    claims: [
      {
        ...claim,
        propertyId: request.property.id,
        provider: "channex",
        externalPropertyId: source.externalPropertyId,
        claimState: "historical",
        claimSource: "migration",
      },
    ],
    connections: [
      {
        ...connection,
        propertyId: request.property.id,
        provider: "channex",
        externalPropertyId: null as string | null,
        legacyExternalPropertyId: source.externalPropertyId,
        migrationRunId: sourceRunId,
        connectionStatus: "disconnected",
      },
    ],
  };
  sourceRead.mockResolvedValue(sourceResult);
  targetRead.mockResolvedValue(target);
  return { request, sourceResult, target };
}
beforeEach(() => vi.resetAllMocks());
describe("historical binding diagnostic composition (mocked reader boundary)", () => {
  it("assembles exact observations with no authority and preserves input", async () => {
    const f = fixture();
    const before = structuredClone(f.request);
    const result = await read(pools, f.request);
    expect(result).toEqual({
      outcome: "supplied_binding_matches_requires_owner_eligibility",
      executable: false,
      observations: { source: f.sourceResult, target: f.target },
    });
    expect(sourceRead).toHaveBeenCalledWith(pools.source, before.sourceRequest);
    expect(targetRead).toHaveBeenCalledWith(pools.target, {
      propertyId: before.property.id,
      externalPropertyId: before.bindingExpected.source.externalPropertyId,
    });
    expect(f.request).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect("observations" in result && Object.isFrozen(result.observations)).toBe(true);
    expect(result).not.toHaveProperty("approved");
    expect(result).not.toHaveProperty("eligible");
  });
  it("keeps seven active synthetic pairs diagnostic and the eighth explicitly held", async () => {
    for (let n = 0; n < 8; n++) {
      const f = fixture(n * 10);
      f.sourceResult.sourceConnections[0]!.active = n !== 7;
      const result = await read(pools, f.request);
      expect(result.executable).toBe(false);
      expect(result.outcome).toBe(
        n === 7 ? "blocked" : "supplied_binding_matches_requires_owner_eligibility",
      );
      if (n === 7)
        expect(result).toMatchObject({ reason: "source_inactive_requires_explicit_disposition" });
    }
  });
  it.each(["id", "hotelId", "externalPropertyId", "rowOrdinal", "rowChecksumSha256"] as const)(
    "rejects inconsistent expected source %s before reads",
    async (key) => {
      const f = fixture();
      Object.assign(f.request.sourceRequest.source, { [key]: key === "rowOrdinal" ? 2 : id(99) });
      expect(await read(pools, f.request)).toMatchObject({ outcome: "blocked", executable: false });
      expect(sourceRead).not.toHaveBeenCalled();
      expect(targetRead).not.toHaveBeenCalled();
    },
  );
  it.each(["run", "property", "hash", "empty_connections"])(
    "rejects invalid %s before reads",
    async (field) => {
      const f = fixture();
      if (field === "run") f.request.sourceRequest.sourceRunId = `vay1351-${"b".repeat(24)}`;
      if (field === "property") f.request.property.id = id(99);
      if (field === "hash") f.request.property.rowStateSha256 = "";
      if (field === "empty_connections") f.request.bindingExpected.connections = [];
      expect(await read(pools, f.request)).toMatchObject({ outcome: "blocked", executable: false });
      expect(sourceRead).not.toHaveBeenCalled();
      expect(targetRead).not.toHaveBeenCalled();
    },
  );
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("rejects protected property or source key %s before reads", async (key) => {
    for (const field of ["propertyId", "hotelId", "externalPropertyId"] as const) {
      const f = fixture();
      if (field === "propertyId") f.request.bindingExpected.propertyId = key;
      else f.request.bindingExpected.source[field] = key;
      expect(await read(pools, f.request)).toMatchObject({
        reason: "protected_fixture",
        executable: false,
      });
    }
    expect(sourceRead).not.toHaveBeenCalled();
    expect(targetRead).not.toHaveBeenCalled();
  });
  it.each(["id", "rowStateSha256"] as const)("rejects returned property %s drift", async (key) => {
    const f = fixture();
    f.target.property[key] = key === "id" ? id(99) : "f".repeat(64);
    expect(await read(pools, f.request)).toMatchObject({
      reason: "property_mismatch",
      executable: false,
    });
  });
  it.each(["missing_claim", "competing_claim", "competing_connection", "live_connection"])(
    "does not hide %s",
    async (mode) => {
      const f = fixture();
      if (mode === "missing_claim") f.target.claims = [];
      if (mode === "competing_claim") f.target.claims.push({ ...f.target.claims[0]!, id: id(99) });
      if (mode === "competing_connection")
        f.target.connections.push({ ...f.target.connections[0]!, id: id(99) });
      if (mode === "live_connection") f.target.connections[0]!.externalPropertyId = id(3);
      const result = await read(pools, f.request);
      expect(result).toMatchObject({ outcome: "blocked", executable: false });
      expect("observations" in result && result.observations.target).toBe(f.target);
    },
  );
  it("snapshots all expected fields before asynchronous readers", async () => {
    const f = fixture();
    sourceRead.mockImplementationOnce(async () => {
      f.request.bindingExpected.propertyId = id(99);
      f.request.property.rowStateSha256 = "0".repeat(64);
      f.request.bindingExpected.connections = [];
      return f.sourceResult;
    });
    expect(await read(pools, f.request)).toMatchObject({
      outcome: "supplied_binding_matches_requires_owner_eligibility",
      executable: false,
    });
    expect(targetRead).toHaveBeenCalledWith(pools.target, {
      propertyId: id(6),
      externalPropertyId: id(3),
    });
  });
  it.each(["source", "target"])("propagates %s read failure without fallback", async (which) => {
    const f = fixture();
    (which === "source" ? sourceRead : targetRead).mockRejectedValueOnce(
      new Error("Evidence unavailable"),
    );
    await expect(read(pools, f.request)).rejects.toThrow("Evidence unavailable");
    if (which === "source") expect(targetRead).not.toHaveBeenCalled();
  });
});
