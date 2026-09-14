import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger, type SourceLedger } from "./channexAdoptionManifestCrypto.js";
import {
  readProductionIdentitySnapshot,
  type ProductionIdentitySnapshot,
} from "./productionIdentitySnapshotReader.js";
import { verifyLegacyPmsSourceProof, type LegacyPmsSourceProof } from "./legacyPmsSourceProof.js";
vi.mock("./channexAdoptionEvidence.js", () => ({ readSourceLedger: vi.fn() }));
vi.mock("./productionIdentitySnapshotReader.js", () => ({
  readProductionIdentitySnapshot: vi.fn(),
}));
const owner = "00000000-0000-4000-8000-000000000001";
const hotel = "00000000-0000-4000-8000-000000000002";
const ledger: SourceLedger = {
  run: {
    run_id: `vay1351-${"a".repeat(24)}`,
    environment: "isolated-fixture",
    source_schema_revision: "fixture-revision",
    cutover_freeze_proof_sha256: null,
    status: "completed",
    finished_at: "2026-09-14T00:00:00.000000Z",
  },
  sources: [],
  tables: [],
};
const proof: LegacyPmsSourceProof = {
  sourceRunId: ledger.run.run_id,
  sourceEnvironment: ledger.run.environment,
  sourceSchemaRevision: ledger.run.source_schema_revision,
  sourceEvidenceSha256: hashSourceLedger(ledger),
  legacyHotelId: hotel,
  ownerUserId: owner,
  hotelRowOrdinal: 1,
  userRowOrdinal: 1,
};
let snapshot: ProductionIdentitySnapshot;
beforeEach(() => {
  vi.resetAllMocks();
  snapshot = {
    sourceHorizonAt: "2026-09-14T00:00:00Z",
    rows: [
      {
        sourceDatabase: "pms",
        sourceTable: "hotels",
        rowOrdinal: 1,
        data: {
          id: hotel,
          user_id: owner,
          name: "Synthetic hotel",
          created_at: "2026-09-01T00:00:00Z",
        },
      },
      {
        sourceDatabase: "auth",
        sourceTable: "users",
        rowOrdinal: 1,
        data: { id: owner, type: "hotel", status: "pending" },
      },
    ],
  };
  vi.mocked(readSourceLedger).mockResolvedValue(structuredClone(ledger));
  vi.mocked(readProductionIdentitySnapshot).mockResolvedValue(snapshot);
});
describe("legacy PMS source proof, mocked validated snapshot boundary", () => {
  it.each(["pending", "verified"] as const)("matches %s without activating it", async (status) => {
    snapshot.rows[1]!.data["status"] = status;
    expect(await verifyLegacyPmsSourceProof({} as never, proof, owner)).toEqual({
      outcome: "source_matches",
      sourceUserStatus: status,
    });
    expect(snapshot.rows[1]!.data["status"]).toBe(status);
  });
  it("rejects a different target owner before any reader call", async () => {
    expect((await verifyLegacyPmsSourceProof({} as never, proof, hotel)).outcome).toBe("blocked");
    expect(readSourceLedger).not.toHaveBeenCalled();
  });
  it.each(["sourceEnvironment", "sourceSchemaRevision", "sourceEvidenceSha256"] as const)(
    "binds %s",
    async (key) => {
      expect(
        (
          await verifyLegacyPmsSourceProof(
            {} as never,
            { ...proof, [key]: key === "sourceEvidenceSha256" ? "b".repeat(64) : "other" },
            owner,
          )
        ).outcome,
      ).toBe("blocked");
      expect(readProductionIdentitySnapshot).not.toHaveBeenCalled();
    },
  );
  it.each(["rejected", "suspended", "deleted", "active", null])(
    "rejects source status %s",
    async (status) => {
      snapshot.rows[1]!.data["status"] = status;
      expect((await verifyLegacyPmsSourceProof({} as never, proof, owner)).outcome).toBe("blocked");
    },
  );
  it.each([
    "duplicate hotel",
    "missing user",
    "wrong hotel owner",
    "wrong ordinal",
    "wrong user type",
  ])("rejects %s", async (change) => {
    if (change === "duplicate hotel") snapshot.rows.push(snapshot.rows[0]!);
    if (change === "missing user") snapshot.rows.pop();
    if (change === "wrong hotel owner") snapshot.rows[0]!.data["user_id"] = hotel;
    if (change === "wrong ordinal") snapshot.rows[0]!.rowOrdinal = 2;
    if (change === "wrong user type") snapshot.rows[1]!.data["type"] = "admin";
    expect((await verifyLegacyPmsSourceProof({} as never, proof, owner)).outcome).toBe("blocked");
  });
  it("propagates snapshot corruption instead of accepting an association", async () => {
    vi.mocked(readProductionIdentitySnapshot).mockRejectedValue(
      new Error("corrupt fixture snapshot"),
    );
    await expect(verifyLegacyPmsSourceProof({} as never, proof, owner)).rejects.toThrow(
      "corrupt fixture snapshot",
    );
  });
});
