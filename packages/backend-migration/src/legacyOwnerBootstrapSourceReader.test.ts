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
vi.mock("./channexAdoptionEvidence.js", () => ({ readSourceLedger: vi.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ledger: SourceLedger = {
  run: {
    run_id: `vay1351-${"a".repeat(24)}`,
    environment: "preprod",
    source_schema_revision: "a".repeat(40),
    status: "completed",
    cutover_freeze_proof_sha256: null,
    finished_at: "2026-09-14T00:00:00.000000Z",
  },
  sources: ["auth", "pms"].map((source_database) => ({
    source_database,
    status: "completed",
    snapshot_identifier_sha256: hashSnapshotIdentifier("fixture"),
    expected_database_name_sha256: "b".repeat(64),
    expected_schema_fingerprint: "c".repeat(32),
    actual_schema_fingerprint: "c".repeat(32),
    row_count: 8,
    checksum_sha256: "d".repeat(64),
    source_snapshot_at: "2026-09-14T00:00:00.000000Z",
  })),
  tables: [],
};
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
    },
  ]);
}
const client = (output = rows(), settings = { readonly: "on", isolation: "repeatable read" }) => ({
  query: vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [settings] })
    .mockImplementation(async (sql: string, _values?: unknown[]) => ({
      rows: sql.includes("AS safe FROM pg_class")
        ? [{ safe: true }]
        : sql.startsWith("SELECT * FROM (")
          ? output
          : [],
    })),
});
beforeEach(() => {
  vi.mocked(readSourceLedger).mockResolvedValue(structuredClone(ledger));
});
describe("bounded source reader", () => {
  it("reports uncertain cleanup distinctly without exposing database errors", async () => {
    const db = client(rows(), { readonly: "off", isolation: "read committed" });
    db.query.mockImplementation(async () => {
      throw Error("private@example.invalid");
    });
    await expect(readLegacyOwnerBootstrapSources(db as never, request())).rejects.toThrow(
      /^OWNER_SOURCE_ROLLBACK_FAILED$/,
    );
  });
  it("reads only exact IDs and returns projected source fields", async () => {
    const db = client(),
      input = request();
    const output = await readLegacyOwnerBootstrapSources(db as never, input);
    expect(output).toHaveLength(8);
    expect(output.every((o) => o.sourceOwnership === "matched")).toBe(true);
    const projection = db.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("SELECT * FROM ("),
    )!;
    expect(projection[1]).toEqual([
      input.sourceRunId,
      input.owners.map((o) => o.ownerId),
      input.owners.map((o) => o.hotelId),
    ]);
    expect(projection[0]).toContain("LIMIT 17");
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
    { readonly: "off", isolation: "repeatable read" },
    { readonly: "on", isolation: "read committed" },
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
});
