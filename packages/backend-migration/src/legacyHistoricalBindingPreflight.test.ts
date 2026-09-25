import { describe, expect, it } from "vitest";
import {
  evaluateLegacyHistoricalBinding,
  type LegacyHistoricalBindingExpected,
  type LegacyHistoricalBindingObserved,
} from "./legacyHistoricalBindingPreflight.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(offset = 0) {
  const expected: LegacyHistoricalBindingExpected = {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    source: {
      id: id(offset + 1),
      hotelId: id(offset + 2),
      externalPropertyId: id(offset + 3),
      rowOrdinal: 1,
      rowChecksumSha256: "b".repeat(64),
    },
    propertyId: id(offset + 2),
    claim: { id: id(offset + 4), rowStateSha256: "c".repeat(64) },
    connections: [{ id: id(offset + 1), rowStateSha256: "d".repeat(64) }],
  };
  const observed: LegacyHistoricalBindingObserved = {
    sourceRunId: expected.sourceRunId,
    sourceConnections: [{ ...expected.source, active: true }],
    claims: [
      {
        ...expected.claim,
        propertyId: expected.propertyId,
        provider: "channex",
        externalPropertyId: expected.source.externalPropertyId,
        claimState: "historical",
        claimSource: "migration",
      },
    ],
    connections: [
      {
        ...expected.connections[0]!,
        propertyId: expected.propertyId,
        provider: "channex",
        connectionStatus: "disconnected",
        externalPropertyId: null,
        legacyExternalPropertyId: expected.source.externalPropertyId,
        migrationRunId: expected.sourceRunId,
      },
    ],
  };
  return { expected, observed, run: () => evaluateLegacyHistoricalBinding(expected, observed) };
}
describe("historical binding supplied-evidence preflight", () => {
  it("preserves seven synthetic active-source pairs; the eighth stays explicitly held", () => {
    for (let index = 0; index < 8; index++) {
      const f = fixture(index * 10);
      f.observed.sourceConnections[0]!.active = index !== 7;
      const before = structuredClone({ expected: f.expected, observed: f.observed });
      expect(f.run()).toEqual(
        index === 7
          ? { outcome: "blocked", reason: "source_inactive_requires_explicit_disposition" }
          : { outcome: "supplied_binding_matches_requires_owner_eligibility" },
      );
      expect({ expected: f.expected, observed: f.observed }).toEqual(before);
    }
  });
  it.each(["sourceConnections", "claims", "connections"] as const)(
    "rejects missing, duplicated or competing %s",
    (field) => {
      const f = fixture();
      f.observed[field] = [];
      expect(f.run().outcome).toBe("blocked");
      const doubled = fixture();
      doubled.observed[field] = [...doubled.observed[field], ...doubled.observed[field]] as never;
      expect(doubled.run().outcome).toBe("blocked");
      const extra = fixture();
      extra.observed[field] = [
        ...extra.observed[field],
        { ...extra.observed[field][0], id: id(99) },
      ] as never;
      expect(extra.run().outcome).toBe("blocked");
    },
  );
  it.each([
    ["id", id(99)],
    ["hotelId", id(99)],
    ["externalPropertyId", id(99)],
    ["rowOrdinal", 2],
    ["rowChecksumSha256", "f".repeat(64)],
    ["active", null],
    ["active", "true"],
  ])("rejects changed source %s", (key, value) => {
    const f = fixture();
    Object.assign(f.observed.sourceConnections[0]!, { [key as string]: value });
    expect(f.run()).toEqual({ outcome: "blocked", reason: "source_mismatch" });
  });
  it.each([
    ["id", id(99)],
    ["propertyId", id(99)],
    ["externalPropertyId", id(99)],
    ["provider", "other"],
    ["rowStateSha256", "e".repeat(64)],
    ["claimState", "active"],
    ["claimState", "released"],
    ["claimState", "verified_non_active"],
    ["claimSource", "adoption"],
    ["claimSource", "enable"],
    ["claimSource", "repair"],
  ])("rejects changed claim %s=%s", (key, value) => {
    const f = fixture();
    Object.assign(f.observed.claims[0]!, { [key!]: value });
    expect(f.run()).toEqual({ outcome: "blocked", reason: "claim_mismatch" });
  });
  it.each([
    ["id", id(99)],
    ["propertyId", id(99)],
    ["provider", "other"],
    ["rowStateSha256", "e".repeat(64)],
    ["connectionStatus", "connected"],
    ["connectionStatus", "degraded"],
    ["externalPropertyId", id(3)],
    ["legacyExternalPropertyId", null],
    ["legacyExternalPropertyId", id(99)],
    ["migrationRunId", null],
    ["migrationRunId", `vay1351-${"f".repeat(24)}`],
  ])("rejects changed target connection %s=%s", (key, value) => {
    const f = fixture();
    Object.assign(f.observed.connections[0]!, { [key!]: value });
    expect(f.run()).toEqual({ outcome: "blocked", reason: "connection_mismatch" });
  });
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("rejects protected key %s even when paired with a different key", (key) => {
    for (const field of ["propertyId", "hotelId", "externalPropertyId"] as const) {
      const f = fixture();
      if (field === "propertyId") f.expected.propertyId = key;
      else f.expected.source[field] = key;
      expect(f.run()).toEqual({ outcome: "blocked", reason: "protected_fixture" });
    }
  });
  it("requires the exact run and valid expected fingerprints", () => {
    const f = fixture();
    f.observed.sourceRunId = `vay1351-${"f".repeat(24)}`;
    expect(f.run()).toEqual({ outcome: "blocked", reason: "source_mismatch" });
    for (const change of [
      (e: LegacyHistoricalBindingExpected) => {
        e.sourceRunId = "unknown";
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.propertyId = "unknown";
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.source.rowOrdinal = 0;
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.source.rowChecksumSha256 = "";
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.claim.rowStateSha256 = "";
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.connections = [];
      },
      (e: LegacyHistoricalBindingExpected) => {
        e.connections = [...e.connections, ...e.connections];
      },
    ]) {
      const bad = fixture();
      change(bad.expected);
      expect(bad.run()).toEqual({ outcome: "blocked", reason: "invalid_expected" });
    }
  });
  it("checks every expected connection, independent of input ordering", () => {
    const f = fixture();
    const additional = { ...f.observed.connections[0]!, id: id(8) };
    f.expected.connections = [
      ...f.expected.connections,
      { id: id(8), rowStateSha256: additional.rowStateSha256 },
    ];
    f.observed.connections = [additional, ...f.observed.connections];
    expect(f.run().outcome).toBe("supplied_binding_matches_requires_owner_eligibility");
    additional.externalPropertyId = id(3);
    expect(f.run()).toEqual({ outcome: "blocked", reason: "connection_mismatch" });
  });
});
