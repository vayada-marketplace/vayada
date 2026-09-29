import { describe, expect, it, vi } from "vitest";

import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import { prepareLegacyHistoricalBindingPreflightInput } from "./legacyHistoricalBindingPreflightPreparation.js";
import { APPROVED_PAIRS } from "./legacyHistoricalBindingPreflightRunner.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";
import { readProductionPmsSnapshot } from "./productionPmsSnapshotReader.js";

vi.mock("./channexAdoptionEvidence.js");
vi.mock("./legacyHistoricalBindingTargetReader.js");
vi.mock("./productionPmsSnapshotReader.js");

const ledger = {
  run: {
    run_id: "vay1351-b68e50b476c7a997f8ac4703",
    environment: "production",
    source_schema_revision: "a".repeat(40),
    cutover_freeze_proof_sha256: "b".repeat(64),
    status: "completed",
    finished_at: "2026-09-01T00:00:00.000000Z",
  },
  sources: [
    {
      source_database: "pms",
      snapshot_identifier_sha256: "c".repeat(64),
      expected_database_name_sha256: "d".repeat(64),
      expected_schema_fingerprint: "e".repeat(32),
      actual_schema_fingerprint: "e".repeat(32),
      status: "completed",
      row_count: 8,
      checksum_sha256: "f".repeat(64),
      source_snapshot_at: "2026-09-01T00:00:00.000000Z",
    },
  ],
  tables: [
    {
      source_database: "pms",
      source_schema: "public",
      source_table: "hotels",
      status: "completed",
      row_count: 0,
      checksum_sha256: "5".repeat(64),
    },
    {
      source_database: "auth",
      source_schema: "public",
      source_table: "users",
      status: "completed",
      row_count: 0,
      checksum_sha256: "6".repeat(64),
    },
  ],
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("historical binding preflight preparation", () => {
  it("builds the canonical pinned eight-pair input from read-only observations", async () => {
    const sortedLedger = structuredClone(ledger);
    sortedLedger.tables.reverse();
    const expectedSourceHash = hashSourceLedger(sortedLedger as never);
    vi.mocked(readSourceLedger).mockResolvedValue(ledger as never);
    vi.mocked(readProductionPmsSnapshot).mockResolvedValue({} as never);
    vi.mocked(readLegacyHistoricalBindingTargetSnapshot).mockImplementation(
      async (_pool, { propertyId }) => ({
        property: { id: propertyId, profileStatus: "private", rowStateSha256: "1".repeat(64) },
        claims: [
          {
            id: uuid(10),
            propertyId,
            provider: "channex",
            externalPropertyId: APPROVED_PAIRS.find(([id]) => id === propertyId)![1],
            claimState: "historical",
            claimSource: "migration",
            rowStateSha256: "2".repeat(64),
          },
        ],
        connections: [
          {
            id: uuid(11),
            propertyId,
            provider: "channex",
            connectionStatus: "disconnected",
            externalPropertyId: null,
            legacyExternalPropertyId: APPROVED_PAIRS.find(([id]) => id === propertyId)![1],
            migrationRunId: ledger.run.run_id,
            rowStateSha256: "3".repeat(64),
          },
        ],
      }),
    );
    let pair = 0;
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("count(*) = 7")) return { rows: [{ complete: true }] };
      if (sql.includes("FROM migration_source_pms.snapshot_rows")) {
        const [hotelId, externalPropertyId] = APPROVED_PAIRS[pair++]!;
        return {
          rows: [
            {
              id: uuid(pair),
              hotelId,
              externalPropertyId,
              rowOrdinal: pair,
              rowChecksumSha256: "4".repeat(64),
              active: pair !== 8,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const raw = await prepareLegacyHistoricalBindingPreflightInput(
      {
        source: { connect: async () => ({ query, release }) } as never,
        target: { connect: vi.fn() } as never,
      },
      "migration-production-2026-09",
    );
    const input = JSON.parse(raw);
    expect(input.requests).toHaveLength(8);
    expect(input.requests[0].sourceRequest.sourceEvidenceSha256).toBe(expectedSourceHash);
    expect(input.requests[7].sourceRequest.source).not.toHaveProperty("active");
    expect(readLegacyHistoricalBindingTargetSnapshot).toHaveBeenCalledTimes(8);
    expect(release).toHaveBeenCalledWith(false);
    expect(raw).toBe(JSON.stringify(input));
  });
});
