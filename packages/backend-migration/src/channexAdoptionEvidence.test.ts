import { describe, expect, it, vi } from "vitest";

import type { ChannexAdoptionManifest } from "./channexAdoptionManifest.js";
import {
  hashExpectedDatabaseName,
  hashOrderedSourceRows,
  hashSnapshotIdentifier,
  hashSourceLedger,
  hashTargetBindingClaims,
  type SourceLedger,
} from "./channexAdoptionManifestCrypto.js";

const dependencies = vi.hoisted(() => ({
  buildCatalogPlan: vi.fn(),
  buildIdentityPlan: vi.fn(),
  planCatalogOwnership: vi.fn(),
  readCatalogSnapshot: vi.fn(),
  readCatalogSourceLinks: vi.fn(),
  readCatalogTarget: vi.fn(),
  readIdentitySnapshot: vi.fn(),
  readIdentityTarget: vi.fn(),
  readPmsSnapshot: vi.fn(),
  readTargetRow: vi.fn(),
}));

vi.mock("./productionCatalogPlan.js", () => ({
  buildProductionCatalogPlan: dependencies.buildCatalogPlan,
}));
vi.mock("./productionCatalogOwnership.js", () => ({
  planCatalogOwnership: dependencies.planCatalogOwnership,
}));
vi.mock("./productionCatalogSnapshotReader.js", () => ({
  readProductionCatalogSnapshot: dependencies.readCatalogSnapshot,
}));
vi.mock("./productionCatalogTargetReader.js", () => ({
  readProductionCatalogSourceLinks: dependencies.readCatalogSourceLinks,
  readProductionCatalogTargetState: dependencies.readCatalogTarget,
}));
vi.mock("./productionIdentityPlan.js", () => ({
  buildProductionIdentityPlan: dependencies.buildIdentityPlan,
}));
vi.mock("./productionIdentitySnapshotReader.js", () => ({
  readProductionIdentitySnapshot: dependencies.readIdentitySnapshot,
}));
vi.mock("./productionIdentityTargetReader.js", () => ({
  readProductionIdentityTargetState: dependencies.readIdentityTarget,
}));
vi.mock("./productionPmsSnapshotReader.js", () => ({
  readProductionPmsSnapshot: dependencies.readPmsSnapshot,
}));
vi.mock("./channexAdoptionTargetRows.js", () => ({
  readAdoptionTargetRow: dependencies.readTargetRow,
}));

import {
  verifyChannexAdoptionSourceEvidence,
  verifyChannexAdoptionTargetEvidence,
} from "./channexAdoptionEvidence.js";

const HASH = "a".repeat(64);
const EMPTY_AGGREGATES = {
  roomTypeMappings: {
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows("pms-channex-room-type-mappings", []),
  },
  ratePlanMappings: {
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows("pms-channex-rate-plan-mappings", []),
  },
  bookingMappings: {
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows("pms-channex-booking-mappings", []),
  },
  bookings: {
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows("pms-bookings", []),
  },
};

describe("Channex adoption evidence", () => {
  it("recomputes the source ledger and validates the exact legacy connection", async () => {
    const manifest = fixtureManifest();
    const client = new EvidenceClient(manifest);

    await expect(verifyChannexAdoptionSourceEvidence(client as never, manifest)).resolves.toBe(
      undefined,
    );
    expect(dependencies.readIdentitySnapshot).toHaveBeenCalledWith(client, manifest.sourceRunId);
    expect(dependencies.readPmsSnapshot).toHaveBeenCalledWith(
      client,
      manifest.sourceRunId,
      expect.any(Object),
    );

    client.ledger.sources[0]!.checksum_sha256 = "b".repeat(64);
    await expect(
      verifyChannexAdoptionSourceEvidence(client as never, manifest),
    ).rejects.toMatchObject({ code: "SOURCE_LEDGER_MISMATCH" });
  });

  it("recomputes target plans and validates every signed target row", async () => {
    const manifest = fixtureManifest();
    const client = new EvidenceClient(manifest);
    arrangeTarget(manifest);

    await expect(verifyChannexAdoptionTargetEvidence(client as never, manifest)).resolves.toBe(
      undefined,
    );
    expect(dependencies.buildIdentityPlan).toHaveBeenCalledOnce();
    expect(dependencies.planCatalogOwnership).toHaveBeenCalledOnce();
    expect(dependencies.buildCatalogPlan).toHaveBeenCalledOnce();
    expect(dependencies.readTargetRow).toHaveBeenCalledTimes(6);

    dependencies.readTargetRow.mockResolvedValueOnce({
      id: manifest.targetPropertyId,
      rowStateSha256: "b".repeat(64),
    });
    await expect(
      verifyChannexAdoptionTargetEvidence(client as never, manifest),
    ).rejects.toMatchObject({ code: "TARGET_ROW_HASH_MISMATCH" });
  });

  it("rejects identity and catalog warning residue", async () => {
    const manifest = fixtureManifest();
    const client = new EvidenceClient(manifest);
    arrangeTarget(manifest);
    dependencies.buildIdentityPlan.mockReturnValueOnce({
      blockers: [],
      quarantinedOrganizations: 1,
      quarantinedResourceLinks: 0,
      resourceLinks: [],
    });
    await expect(
      verifyChannexAdoptionTargetEvidence(client as never, manifest),
    ).rejects.toMatchObject({ code: "IDENTITY_PLAN_WARNINGS" });

    arrangeTarget(manifest);
    dependencies.buildCatalogPlan.mockReturnValueOnce({
      blockers: [],
      quarantinedSources: [{ reason: "missing_canonical_property" }],
      sourceLinks: [],
    });
    await expect(
      verifyChannexAdoptionTargetEvidence(client as never, manifest),
    ).rejects.toMatchObject({ code: "CATALOG_PLAN_WARNINGS" });
  });
});

function arrangeTarget(manifest: ChannexAdoptionManifest): void {
  vi.clearAllMocks();
  dependencies.readIdentitySnapshot.mockResolvedValue({ rows: [], sourceHorizonAt: "2026-09-12" });
  dependencies.readIdentityTarget.mockResolvedValue({});
  dependencies.buildIdentityPlan.mockReturnValue({
    blockers: [],
    quarantinedOrganizations: 0,
    quarantinedResourceLinks: 0,
    resourceLinks: [
      {
        organizationId: manifest.targetOrganizationId,
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: manifest.legacyPmsHotelId,
        relationship: "operator",
        status: "active",
      },
    ],
  });
  dependencies.readCatalogSnapshot.mockResolvedValue([]);
  dependencies.readCatalogSourceLinks.mockResolvedValue([]);
  dependencies.planCatalogOwnership.mockReturnValue({
    blockers: [],
    properties: [{ propertyId: manifest.targetPropertyId }],
  });
  dependencies.readCatalogTarget.mockResolvedValue({});
  dependencies.buildCatalogPlan.mockReturnValue({
    blockers: [],
    quarantinedSources: [],
    sourceLinks: [
      {
        propertyId: manifest.targetPropertyId,
        sourceSystem: "pms",
        sourceTable: "hotels",
        sourceId: manifest.legacyPmsHotelId,
        relationship: "operational_input",
        migrationDisposition: "canonical",
        migrationDispositionReason: null,
      },
    ],
  });
  dependencies.readTargetRow.mockImplementation(async (_client, _table, id: string) => {
    const evidence = manifest.targetEvidence;
    const hashes = new Map(
      [
        evidence.property,
        evidence.sourceLink,
        evidence.legacyResourceLink,
        evidence.targetResourceLink,
        evidence.targetPmsResourceLink,
        evidence.organization,
      ].map((row) => [row.id, row.rowStateSha256]),
    );
    return { id, rowStateSha256: hashes.get(id) ?? HASH };
  });
}

class EvidenceClient {
  readonly ledger: SourceLedger;

  constructor(private readonly manifest: ChannexAdoptionManifest) {
    this.ledger = sourceLedger(manifest);
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    const manifest = this.manifest;
    if (sql.includes("FROM platform.source_extraction_runs"))
      return { rows: [this.ledger.run] as T[] };
    if (sql.includes("FROM platform.source_extraction_sources"))
      return {
        rows: this.ledger.sources.map((row) => ({
          ...row,
          snapshot_identifier: "snapshot-pms",
          expected_database_name: "pms",
          row_count: String(row.row_count),
        })) as T[],
      };
    if (sql.includes("FROM platform.source_extraction_tables"))
      return {
        rows: this.ledger.tables.map((row) => ({
          ...row,
          row_count: String(row.row_count),
        })) as T[],
      };
    if (sql.includes("FROM migration_source_pms.snapshot_rows"))
      return {
        rows: [
          {
            sourceTable: "hotels",
            rowOrdinal: "1",
            rowChecksumSha256: HASH,
            rowData: {
              id: manifest.legacyPmsHotelId,
              user_id: manifest.legacyEvidence.hotel.userId,
            },
          },
          {
            sourceTable: "channex_connections",
            rowOrdinal: "2",
            rowChecksumSha256: HASH,
            rowData: {
              hotel_id: manifest.legacyPmsHotelId,
              channex_property_id: manifest.externalPropertyId,
              is_active: true,
            },
          },
        ] as T[],
      };
    if (sql.includes("FROM hotel_catalog.property_source_links WHERE id"))
      return {
        rows: [
          {
            propertyId: manifest.targetPropertyId,
            sourceSystem: "pms",
            sourceTable: "hotels",
            sourceId: manifest.legacyPmsHotelId,
            relationship: "operational_input",
            status: "active",
            metadata: {
              migrationRunId: manifest.sourceRunId,
              migrationPhase: "complete",
              migrationDisposition: "canonical",
              migrationDispositionReason: null,
            },
          },
        ] as T[],
      };
    if (sql.includes("status = 'active' AND resource_id"))
      return {
        rows: [
          {
            id: manifest.targetResourceLinkId,
            organizationId: manifest.targetOrganizationId,
            product: "hotel_catalog",
          },
          {
            id: manifest.targetPmsResourceLinkId,
            organizationId: manifest.targetOrganizationId,
            product: "pms",
          },
        ] as T[],
      };
    if (sql.includes("FROM identity.organization_resource_links WHERE id"))
      return {
        rows: [
          {
            organizationId: manifest.targetOrganizationId,
            product: "pms",
            resourceType: "pms_hotel",
            resourceId: manifest.legacyPmsHotelId,
            relationship: "operator",
            status: "active",
          },
        ] as T[],
      };
    if (sql.includes("FROM identity.organization_resource_links")) return { rows: [] as T[] };
    if (sql.includes("FROM identity.organizations"))
      return { rows: [{ kind: "hotel_group", status: "active" }] as T[] };
    if (sql.includes("FROM pms.channel_binding_claims")) return { rows: [] as T[] };
    throw new Error(`Unexpected evidence query: ${sql}`);
  }
}

function sourceLedger(manifest: ChannexAdoptionManifest): SourceLedger {
  return {
    run: {
      run_id: manifest.sourceRunId,
      environment: manifest.sourceEnvironment,
      source_schema_revision: manifest.sourceSchemaRevision,
      cutover_freeze_proof_sha256: null,
      status: "completed",
      finished_at: "2026-09-12T09:00:00.000000Z",
    },
    sources: [
      {
        source_database: "pms",
        snapshot_identifier_sha256: hashSnapshotIdentifier("snapshot-pms"),
        expected_database_name_sha256: hashExpectedDatabaseName("pms"),
        expected_schema_fingerprint: HASH,
        actual_schema_fingerprint: HASH,
        status: "completed",
        row_count: 2,
        checksum_sha256: HASH,
        source_snapshot_at: "2026-09-12T09:00:00.000000Z",
      },
    ],
    tables: [
      {
        source_database: "pms",
        source_schema: "public",
        source_table: "hotels",
        status: "completed",
        row_count: 1,
        checksum_sha256: HASH,
      },
    ],
  };
}

function fixtureManifest(): ChannexAdoptionManifest {
  const manifest = {
    contractVersion: "channex-property-adoption.v1",
    manifestId: uuid(1),
    issuedAt: "2026-09-12T10:00:00.000Z",
    expiresAt: "2026-09-12T11:00:00.000Z",
    environment: "local",
    sourceEnvironment: "local",
    sourceRunId: "vay1351-000000000000000000000001",
    sourceSchemaRevision: "b".repeat(40),
    sourceEvidenceSha256: "",
    legacyPmsHotelId: uuid(2),
    externalPropertyId: uuid(3),
    targetPropertyId: uuid(4),
    targetOrganizationId: uuid(5),
    targetSourceLinkId: uuid(6),
    legacyResourceLinkId: uuid(7),
    targetResourceLinkId: uuid(8),
    targetPmsResourceLinkId: uuid(9),
    legacyEvidence: {
      hotel: { rowOrdinal: 1, rowChecksumSha256: HASH, userId: uuid(10) },
      connection: { rowOrdinal: 2, rowChecksumSha256: HASH },
      ...EMPTY_AGGREGATES,
    },
    targetEvidence: {
      property: { id: uuid(4), rowStateSha256: HASH },
      sourceLink: {
        id: uuid(6),
        rowStateSha256: HASH,
        migrationRunId: "vay1351-000000000000000000000001",
        migrationPhase: "complete",
        migrationDisposition: "canonical",
      },
      legacyResourceLink: { id: uuid(7), rowStateSha256: HASH },
      targetResourceLink: { id: uuid(8), rowStateSha256: HASH },
      targetPmsResourceLink: { id: uuid(9), rowStateSha256: HASH },
      organization: { id: uuid(5), rowStateSha256: HASH },
      bindingClaims: {
        rowCount: 0,
        orderedRowsSha256: hashTargetBindingClaims([]),
      },
    },
    approvalSubjectSha256: HASH,
    approvalEvidence: [] as never,
    signingKeyId: "migration-local-2026-01",
  } satisfies ChannexAdoptionManifest;
  manifest.sourceEvidenceSha256 = hashSourceLedger(sourceLedger(manifest));
  return manifest;
}

function uuid(value: number): string {
  return `19630000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
