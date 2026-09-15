import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { hashLegacyOwnerSetupValue as hash } from "./legacyOwnerSetupReceiptHashes.js";
import { verifyLegacyOwnerCurrentSourceEvidence as verifyEvidence } from "./legacyOwnerCurrentSourceEvidence.js";

const commandKeys = generateKeyPairSync("ed25519"),
  sourceKeys = generateKeyPairSync("ed25519");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64),
  now = new Date("2026-09-15T01:05:00.000Z");
const domain = "vayada:legacy-owner-internal-setup:v1\0";
const signSource = (payload: string, prefix = domain + "current-source-attestation\0") =>
  sign(null, Buffer.from(prefix + payload), sourceKeys.privateKey).toString("base64url");
function fixture(change: Record<string, unknown> = {}, count = 1) {
  const expected = {
    environment: "local" as const,
    targetDatabaseSha256: sha,
    source: {
      sourceRunId: "vay1351-" + "a".repeat(24),
      ledgerSha256: sha,
      sourceEnvironment: "local",
      sourceSchemaRevision: "synthetic",
      owners: Array.from({ length: 8 }, (_, i) => ({
        ownerId: id(i + 1),
        hotelId: id(i + 11),
        userOrdinal: i + 1,
        hotelOrdinal: i + 1,
        userSha256: sha,
        hotelSha256: sha,
      })),
    },
  };
  const rows = expected.source.owners.slice(0, count).map((o) => ({
    contractVersion: "legacy-owner-current-source.v1",
    environment: "local",
    sourceRunId: expected.source.sourceRunId,
    sourceLedgerSha256: sha,
    ownerId: o.ownerId,
    hotelId: o.hotelId,
    authDatabaseSha256: sha,
    pmsDatabaseSha256: sha,
    authObservedAt: "2026-09-15T01:00:00.000Z",
    pmsObservedAt: "2026-09-15T01:00:01.000Z",
    sourceStatus: "pending",
    email: `private-${o.ownerId}@example.invalid`,
    name: null,
    signingKeyId: "live-source",
    ...change,
  }));
  const command = {
    contractVersion: "legacy-owner-internal-setup.v1",
    commandId: id(99),
    environment: "local",
    issuedAt: "2026-09-15T01:01:00.000Z",
    expiresAt: "2026-09-15T01:15:00.000Z",
    targetDatabaseSha256: sha,
    sourceRunId: expected.source.sourceRunId,
    sourceLedgerSha256: sha,
    owners: expected.source.owners
      .slice(0, count)
      .map((o, i) => ({
        ...o,
        email: `private-${o.ownerId}@example.invalid`,
        name: null,
        status: "pending",
        expectedTarget: "absent",
        targetBeforeSha256: sha,
        currentEvidenceSha256: hash("current-source-evidence", rows[i]),
        observedAt: "2026-09-15T01:00:00.000Z",
      })),
  };
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
  const input = {
    commandPayload: canonicalizeJson(command),
    envelopePayload,
    detachedSignature: sign(
      null,
      Buffer.from(domain + "envelope\0" + envelopePayload),
      commandKeys.privateKey,
    ).toString("base64url"),
    verificationKeys: new Map([["command", commandKeys.publicKey]]),
  };
  const artifacts = rows.map((row) => {
    const canonicalPayload = canonicalizeJson(row);
    return { canonicalPayload, detachedSignature: signSource(canonicalPayload) };
  });
  const trust = {
    environment: "local",
    authDatabaseSha256: sha,
    pmsDatabaseSha256: sha,
    verificationKeys: new Map([["live-source", sourceKeys.publicKey]]),
  };
  return { input, expected, artifacts, trust };
}
const run = (f = fixture(), at = now) =>
  verifyEvidence(f.input, f.expected, f.artifacts, f.trust, at);
const reject = (f: ReturnType<typeof fixture>) =>
  expect(() => run(f)).toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_EVIDENCE_INVALID$/);

describe("protected current source attestations, synthetic keys only", () => {
  it.each([1, 2, 8])(
    "authenticates exact %i-owner scope without contacts or authority",
    (count) => {
      const result = run(fixture({}, count));
      expect(result).toMatchObject({
        outcome: "current_source_attestations_match",
        executable: false,
        ownerCount: count,
      });
      expect(JSON.stringify(result)).not.toMatch(/private|@|name|email/);
    },
  );
  it.each([
    ["contractVersion", "snapshot.v1"],
    ["environment", "production"],
    ["sourceRunId", "vay1351-" + "b".repeat(24)],
    ["sourceLedgerSha256", "b".repeat(64)],
    ["ownerId", id(7)],
    ["hotelId", id(17)],
    ["authDatabaseSha256", "b".repeat(64)],
    ["pmsDatabaseSha256", "b".repeat(64)],
    ["sourceStatus", "suspended"],
    ["sourceStatus", "rejected"],
    ["sourceStatus", "unknown"],
    ["email", "changed@example.invalid"],
    ["name", "changed"],
    ["signingKeyId", "snapshot-source"],
    ["authObservedAt", "2026-09-15T00:59:59.000Z"],
    ["pmsObservedAt", "2026-09-15T01:01:01.000Z"],
    ["pmsObservedAt", "2026-09-15T01:00:00Z"],
    ["pmsObservedAt", "2026-02-30T00:00:00.000Z"],
    ["extra", "unexpected"],
  ])("rejects signed but inconsistent %s", (field, value) => reject(fixture({ [field!]: value })));
  it("also admits verified source status without activating the target", () => {
    expect(run(fixture({ sourceStatus: "verified" })).executable).toBe(false);
  });
  it.each(["missing", "extra", "duplicate"])("rejects %s artifact", (mode) => {
    const f = fixture({}, 2);
    if (mode === "missing") f.artifacts.pop();
    if (mode === "extra") f.artifacts.push(f.artifacts[0]!);
    if (mode === "duplicate") f.artifacts[1] = f.artifacts[0]!;
    reject(f);
  });
  it.each(["signature", "domain", "encoding", "payload", "canonical", "key", "trust", "request"])(
    "rejects changed %s",
    (mode) => {
      const f = fixture(),
        a = f.artifacts[0]!;
      if (mode === "signature") a.detachedSignature = "bad";
      if (mode === "domain")
        a.detachedSignature = signSource(a.canonicalPayload, domain + "envelope\0");
      if (mode === "encoding") a.detachedSignature += "=";
      if (mode === "payload")
        a.canonicalPayload = a.canonicalPayload.replace("pending", "verified");
      if (mode === "canonical") a.canonicalPayload += " ";
      if (mode === "key") f.trust.verificationKeys.set("live-source", commandKeys.publicKey);
      if (mode === "trust") f.trust.authDatabaseSha256 = "b".repeat(64);
      if (mode === "request") f.input.detachedSignature = "bad";
      reject(f);
    },
  );
  it("rejects expired and invalid clocks", () => {
    for (const at of [new Date("2026-09-15T01:15:00.000Z"), new Date(NaN)])
      expect(() => run(fixture(), at)).toThrow("LEGACY_OWNER_CURRENT_SOURCE_EVIDENCE_INVALID");
  });
});
