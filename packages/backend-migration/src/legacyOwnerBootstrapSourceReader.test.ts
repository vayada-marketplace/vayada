import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import {
  hashSourceLedger,
  hashSnapshotIdentifier,
  type SourceLedger,
} from "./channexAdoptionManifestCrypto.js";
import {
  readLegacyOwnerBootstrapSources,
  type OwnerSourceRequest,
} from "./legacyOwnerBootstrapSourceReader.js";
import { VAY_1350_ACTIVE_SOURCE_TABLES } from "./productionIdentitySnapshotReader.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";
import { HISTORICAL_SOURCE_TABLES } from "./rawSourceDispositions.js";
vi.mock("./channexAdoptionEvidence.js", () => ({ readSourceLedger: vi.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ledger: SourceLedger = {
  run: {
    run_id: `vay1351-${"a".repeat(24)}`,
    environment: "preprod",
    source_schema_revision: VAY_1350_INVENTORY_REVISION,
    status: "completed",
    cutover_freeze_proof_sha256: null,
    finished_at: "2026-09-14T00:00:00.000000Z",
  },
  sources: [],
  tables: [],
};
for (const database of ["auth", "booking", "marketplace", "pms"] as const) {
  const aggregate = createHash("sha256");
  for (const qualified of VAY_1350_ACTIVE_SOURCE_TABLES[database]) {
    const [source_schema, source_table] = qualified.split(".") as [string, string];
    const checksum_sha256 = createHash("sha256").digest("hex");
    ledger.tables.push({
      source_database: database,
      source_schema,
      source_table,
      status: "completed",
      row_count: 0,
      checksum_sha256,
    });
    aggregate.update(`${qualified}|0|${checksum_sha256}\n`);
  }
  ledger.sources.push({
    source_database: database,
    status: "completed",
    snapshot_identifier_sha256: hashSnapshotIdentifier("fixture"),
    expected_database_name_sha256: "b".repeat(64),
    expected_schema_fingerprint: "c".repeat(32),
    actual_schema_fingerprint: "c".repeat(32),
    row_count: 0,
    checksum_sha256: aggregate.digest("hex"),
    source_snapshot_at: "2026-09-14T00:00:00.000000Z",
  });
}
ledger.tables.sort((left, right) =>
  `${left.source_database}\0${left.source_schema}\0${left.source_table}`.localeCompare(
    `${right.source_database}\0${right.source_schema}\0${right.source_table}`,
  ),
);
function request(): OwnerSourceRequest {
  return {
    sourceRunId: ledger.run.run_id,
    sourceEnvironment: "preprod",
    sourceSchemaRevision: ledger.run.source_schema_revision,
    ledgerSha256: hashSourceLedger(ledger),
    owners: Array.from({ length: 8 }, (_, i) => ({
      ownerId: id(i + 1),
      hotelId: id(i + 21),
      userOrdinal: i + 1,
      hotelOrdinal: i + 1,
      userSha256: "e".repeat(64),
      hotelSha256: "f".repeat(64),
    })),
  };
}
function rows() {
  return request().owners.flatMap((owner) => [
    {
      database: "auth",
      id: owner.ownerId,
      email: "synthetic@example.invalid",
      status: "pending",
      type: "hotel",
      ownerId: null,
      ordinal: String(owner.userOrdinal),
      sha: owner.userSha256,
      valid: true,
      snapshot: "fixture",
      transactionId: "100",
    },
    {
      database: "pms",
      id: owner.hotelId,
      email: null,
      status: null,
      type: null,
      ownerId: owner.ownerId,
      ordinal: String(owner.hotelOrdinal),
      sha: owner.hotelSha256,
      valid: true,
      snapshot: "fixture",
      transactionId: "100",
    },
  ]);
}
const client = (
  output = rows(),
  settings = { readonly: "on", isolation: "repeatable read", transactionId: "100" },
) => ({
  query: vi
    .fn()
    .mockResolvedValueOnce({ rows: [settings] })
    .mockResolvedValueOnce({ rows: output }),
});
beforeEach(() => {
  vi.mocked(readSourceLedger).mockResolvedValue(structuredClone(ledger));
});
describe("bounded source reader", () => {
  it("accepts complete historical extraction evidence but rejects a partial set", async () => {
    const changed = structuredClone(ledger);
    const emptyChecksum = createHash("sha256").digest("hex");
    for (const qualified of HISTORICAL_SOURCE_TABLES) {
      const [source_schema, source_table] = qualified.split(".") as [string, string];
      changed.tables.push({
        source_database: "pms",
        source_schema,
        source_table,
        status: "completed",
        row_count: 0,
        checksum_sha256: emptyChecksum,
      });
    }
    const aggregate = createHash("sha256");
    for (const qualified of [...VAY_1350_ACTIVE_SOURCE_TABLES.pms, ...HISTORICAL_SOURCE_TABLES]) {
      aggregate.update(`${qualified}|0|${emptyChecksum}\n`);
    }
    changed.sources.find((source) => source.source_database === "pms")!.checksum_sha256 =
      aggregate.digest("hex");
    changed.tables.sort((left, right) =>
      `${left.source_database}\0${left.source_schema}\0${left.source_table}`.localeCompare(
        `${right.source_database}\0${right.source_schema}\0${right.source_table}`,
      ),
    );
    vi.mocked(readSourceLedger).mockResolvedValue(changed);
    const input = request();
    input.ledgerSha256 = hashSourceLedger(changed);
    await expect(readLegacyOwnerBootstrapSources(client() as never, input)).resolves.toHaveLength(
      8,
    );

    changed.tables = changed.tables.filter(
      (row) =>
        !(
          row.source_schema === "inbox_prototype_archive_20260905" &&
          row.source_table === "message_templates"
        ),
    );
    input.ledgerSha256 = hashSourceLedger(changed);
    await expect(readLegacyOwnerBootstrapSources(client() as never, input)).rejects.toThrow(
      "OWNER_SOURCE_READ_FAILED",
    );
  });

  it("reads only exact IDs and returns projected source fields", async () => {
    const db = client(),
      input = request();
    const output = await readLegacyOwnerBootstrapSources(db as never, input);
    expect(output).toHaveLength(8);
    expect(output.every((o) => o.sourceOwnership === "matched")).toBe(true);
    expect(db.query.mock.calls[1]![1]).toEqual([
      input.sourceRunId,
      input.owners.map((o) => o.ownerId),
      input.owners.map((o) => o.hotelId),
    ]);
    expect(db.query.mock.calls[1]![0]).toContain("LIMIT 17");
    expect(Object.keys(output[0]!)).toEqual([
      "ownerId",
      "email",
      "sourceStatus",
      "sourceOwnership",
    ]);
  });
  it.each(["missing", "extra", "duplicate", "checksum", "ordinal", "snapshot"])(
    "rejects %s rows",
    async (mode) => {
      const output = rows();
      if (mode === "missing") output.pop();
      if (mode === "extra") output.push(output[0]!);
      if (mode === "duplicate") output[2] = output[0]!;
      if (mode === "checksum") output[0]!.valid = false;
      if (mode === "ordinal") output[0]!.ordinal = "999";
      if (mode === "snapshot") output[0]!.snapshot = "other";
      await expect(
        readLegacyOwnerBootstrapSources(client(output) as never, request()),
      ).rejects.toThrow("OWNER_SOURCE_READ_FAILED");
    },
  );
  it("preserves restrictions and ownership conflicts without claiming access", async () => {
    const output = rows();
    output[0]!.status = "suspended";
    output[1]!.ownerId = id(99);
    expect(
      (await readLegacyOwnerBootstrapSources(client(output) as never, request()))[0],
    ).toMatchObject({ sourceStatus: "suspended", sourceOwnership: "conflict" });
  });
  it.each(["missing", "duplicate", "protected", "hash"])(
    "rejects %s scope before reads",
    async (mode) => {
      const input = request(),
        db = client();
      if (mode === "missing") input.owners.pop();
      if (mode === "duplicate") input.owners[1] = input.owners[0]!;
      if (mode === "protected") input.owners[0]!.hotelId = "65f6b2fc-c783-4963-9d6b-a85f82319769";
      if (mode === "hash") input.owners[0]!.userSha256 = "invalid";
      await expect(readLegacyOwnerBootstrapSources(db as never, input)).rejects.toThrow(
        "INVALID_OWNER_SOURCE_SCOPE",
      );
      expect(db.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    { readonly: "off", isolation: "repeatable read", transactionId: "100" },
    { readonly: "on", isolation: "read committed", transactionId: "100" },
  ])("rejects unsafe transaction %j", async (settings) => {
    await expect(
      readLegacyOwnerBootstrapSources(client(rows(), settings) as never, request()),
    ).rejects.toThrow("OWNER_SOURCE_READ_FAILED");
  });
  it("rejects ledger drift and sanitizes errors", async () => {
    const input = request();
    input.ledgerSha256 = "0".repeat(64);
    await expect(readLegacyOwnerBootstrapSources(client() as never, input)).rejects.toThrow(
      "OWNER_SOURCE_READ_FAILED",
    );
    const db = client();
    db.query.mockReset().mockRejectedValue(new Error("private@example.invalid"));
    await expect(readLegacyOwnerBootstrapSources(db as never, request())).rejects.toThrow(
      /^OWNER_SOURCE_READ_FAILED$/,
    );
    vi.mocked(readSourceLedger).mockRejectedValue(new Error("private@example.invalid"));
    await expect(readLegacyOwnerBootstrapSources(client() as never, request())).rejects.toThrow(
      /^OWNER_SOURCE_READ_FAILED$/,
    );
  });
  it.each(["missing_table", "failed_table", "extra_table", "fingerprint", "aggregate"])(
    "rejects incomplete ledger evidence: %s",
    async (mode) => {
      const changed = structuredClone(ledger);
      if (mode === "missing_table") changed.tables.pop();
      if (mode === "failed_table") changed.tables[0]!.status = "failed";
      if (mode === "extra_table")
        changed.tables.push({ ...changed.tables[0]!, source_table: "extra" });
      if (mode === "fingerprint") changed.sources[0]!.actual_schema_fingerprint = "0".repeat(32);
      if (mode === "aggregate") changed.sources[0]!.checksum_sha256 = "0".repeat(64);
      changed.tables.sort((left, right) =>
        `${left.source_database}\0${left.source_schema}\0${left.source_table}`.localeCompare(
          `${right.source_database}\0${right.source_schema}\0${right.source_table}`,
        ),
      );
      const input = request();
      input.ledgerSha256 = hashSourceLedger(changed);
      vi.mocked(readSourceLedger).mockResolvedValue(changed);
      await expect(readLegacyOwnerBootstrapSources(client() as never, input)).rejects.toThrow(
        "OWNER_SOURCE_READ_FAILED",
      );
    },
  );
  it.each(["wrong_revision", "empty_snapshot", "missing_snapshot_time", "invalid_snapshot_time"])(
    "rejects invalid source provenance: %s",
    async (mode) => {
      const changed = structuredClone(ledger);
      if (mode === "wrong_revision") changed.run.source_schema_revision = "unsupported";
      if (mode === "empty_snapshot")
        changed.sources[0]!.snapshot_identifier_sha256 = hashSnapshotIdentifier("");
      if (mode === "missing_snapshot_time") changed.sources[0]!.source_snapshot_at = "";
      if (mode === "invalid_snapshot_time") changed.sources[0]!.source_snapshot_at = "invalid";
      const input = request();
      input.sourceSchemaRevision = changed.run.source_schema_revision;
      input.ledgerSha256 = hashSourceLedger(changed);
      vi.mocked(readSourceLedger).mockResolvedValue(changed);
      const expectedError =
        mode === "wrong_revision" ? "INVALID_OWNER_SOURCE_SCOPE" : "OWNER_SOURCE_READ_FAILED";
      await expect(readLegacyOwnerBootstrapSources(client() as never, input)).rejects.toThrow(
        expectedError,
      );
    },
  );
  it("rejects a transaction change between ledger and row reads", async () => {
    const output = rows();
    output[0]!.transactionId = "101";
    await expect(
      readLegacyOwnerBootstrapSources(client(output) as never, request()),
    ).rejects.toThrow("OWNER_SOURCE_READ_FAILED");
  });
});
import { createHash } from "node:crypto";
