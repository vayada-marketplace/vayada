import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectLegacyOwnerCurrentSourceEvidence as collect } from "./legacyOwnerCurrentSourceCollector.js";
import { readLegacyOwnerCurrentSources as read } from "./legacyOwnerCurrentSourceReader.js";
import { verifyLegacyOwnerCurrentSourceEvidence as verify } from "./legacyOwnerCurrentSourceEvidence.js";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { hashLegacyOwnerSetupValue as hash } from "./legacyOwnerSetupReceiptHashes.js";

vi.mock("./legacyOwnerCurrentSourceReader.js", () => ({ readLegacyOwnerCurrentSources: vi.fn() }));
const keys = generateKeyPairSync("ed25519");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64),
  at = new Date("2026-09-15T01:00:00.000Z");
const pairs = Array.from({ length: 8 }, (_, i) => ({ ownerId: id(i + 1), hotelId: id(i + 11) }));
const rows = pairs.map((p) => ({
  ...p,
  email: `${p.ownerId}@example.invalid`,
  name: null,
  sourceStatus: "pending" as const,
  authObservedAt: at.toISOString(),
  pmsObservedAt: at.toISOString(),
}));
function fixture() {
  return {
    source: {
      pairs: structuredClone(pairs),
      auth: { databaseName: "auth", databaseOid: 1 },
      pms: { databaseName: "pms", databaseOid: 2 },
    },
    metadata: {
      environment: "local",
      sourceRunId: "vay1351-" + "a".repeat(24),
      sourceLedgerSha256: sha,
      authDatabaseSha256: sha,
      pmsDatabaseSha256: sha,
      signingKeyId: "live-source",
    },
    keys: { ...keys },
  };
}
const run = (f = fixture(), clock = () => at) =>
  collect({} as never, {} as never, f.source, f.metadata, f.keys, clock);
beforeEach(() => {
  vi.mocked(read).mockReset().mockResolvedValue(structuredClone(rows));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(read).mockReset();
});

it("produces artifacts accepted by the existing full signed-request verifier", async () => {
  const f = fixture(),
    artifacts = await run(f);
  const owners = pairs.map((p, i) => ({
    ...p,
    userOrdinal: i + 1,
    hotelOrdinal: i + 1,
    userSha256: sha,
    hotelSha256: sha,
  }));
  const command = {
    contractVersion: "legacy-owner-internal-setup.v1",
    commandId: id(99),
    environment: "local",
    issuedAt: at.toISOString(),
    expiresAt: "2026-09-15T01:10:00.000Z",
    targetDatabaseSha256: sha,
    sourceRunId: f.metadata.sourceRunId,
    sourceLedgerSha256: sha,
    owners: owners.map((o, i) => ({
      ...o,
      email: rows[i]!.email,
      name: null,
      status: "pending",
      expectedTarget: "absent",
      targetBeforeSha256: sha,
      observedAt: at.toISOString(),
      currentEvidenceSha256: hash(
        "current-source-evidence",
        JSON.parse(artifacts[i]!.canonicalPayload),
      ),
    })),
  };
  const commandKeys = generateKeyPairSync("ed25519");
  const envelopePayload = canonicalizeJson({
    contractVersion: command.contractVersion,
    commandId: command.commandId,
    environment: command.environment,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    commandSha256: hash("command", command),
    migrationApprovalRecordId: id(90),
    securityApprovalRecordId: id(91),
    signingKeyId: "command",
  });
  const result = verify(
    {
      commandPayload: canonicalizeJson(command),
      envelopePayload,
      detachedSignature: sign(
        null,
        Buffer.from("vayada:legacy-owner-internal-setup:v1\0envelope\0" + envelopePayload),
        commandKeys.privateKey,
      ).toString("base64url"),
      verificationKeys: new Map([["command", commandKeys.publicKey]]),
    },
    {
      environment: "local",
      targetDatabaseSha256: sha,
      source: {
        sourceRunId: f.metadata.sourceRunId,
        ledgerSha256: sha,
        sourceEnvironment: "local",
        sourceSchemaRevision: "synthetic",
        owners,
      },
    },
    artifacts,
    {
      environment: "local",
      authDatabaseSha256: sha,
      pmsDatabaseSha256: sha,
      verificationKeys: new Map([["live-source", keys.publicKey]]),
    },
    at,
  );
  expect(result).toMatchObject({ executable: false, ownerCount: 8 });
  expect(read).toHaveBeenCalledTimes(1);
});
it.each([
  "environment",
  "sourceRunId",
  "sourceLedgerSha256",
  "authDatabaseSha256",
  "pmsDatabaseSha256",
  "signingKeyId",
  "extra",
])("rejects invalid %s before source reads", async (field) => {
  const f = fixture();
  Object.assign(f.metadata, { [field]: "invalid!" });
  await expect(run(f)).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED$/);
  expect(read).not.toHaveBeenCalled();
});
it.each(["mismatch", "publicOnly", "wrongType"])(
  "rejects %s signing key before reads",
  async (mode) => {
    const f = fixture();
    if (mode === "mismatch") f.keys.publicKey = generateKeyPairSync("ed25519").publicKey;
    if (mode === "publicOnly") f.keys.privateKey = keys.publicKey;
    if (mode === "wrongType") f.keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await expect(run(f)).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED$/);
    expect(read).not.toHaveBeenCalled();
  },
);
it("captures trusted metadata, source pairs and key references before awaiting", async () => {
  const f = fixture();
  vi.mocked(read).mockImplementationOnce(async (_a, _p, source) => {
    f.metadata.environment = "production";
    f.source.pairs[0]!.hotelId = id(88);
    f.keys.privateKey = generateKeyPairSync("ed25519").privateKey;
    expect(source.pairs[0]!.hotelId).toBe(pairs[0]!.hotelId);
    return structuredClone(rows);
  });
  const artifacts = await run(f);
  expect(JSON.parse(artifacts[0]!.canonicalPayload).environment).toBe("local");
});
it("sanitizes source errors and returns no artifacts", async () => {
  vi.mocked(read).mockRejectedValueOnce(new Error("private-contact@example.invalid"));
  await expect(run()).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED$/);
});
it.each(["invalid", "backward", "expiry", "elapsed", "postSigning"])(
  "rejects %s clock",
  async (mode) => {
    let calls = 0;
    if (mode === "elapsed")
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(900000);
    const clock = () => {
      const n = calls++;
      if (mode === "invalid") return new Date(NaN);
      if (mode === "postSigning") return new Date(at.getTime() + (n >= 2 ? 900000 : 0));
      return new Date(
        at.getTime() + (n > 0 ? (mode === "backward" ? -1 : mode === "expiry" ? 900000 : 0) : 0),
      );
    };
    await expect(run(fixture(), clock)).rejects.toThrow(
      /^LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED$/,
    );
  },
);
