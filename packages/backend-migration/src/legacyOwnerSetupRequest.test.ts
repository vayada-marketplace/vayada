import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { verifyLegacyOwnerSetupRequest } from "./legacyOwnerSetupRequest.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const now = new Date("2026-09-15T01:05:00.000Z");
const context = {
  environment: "local" as const,
  targetDatabaseSha256: hash,
  source: {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    ledgerSha256: hash,
    sourceEnvironment: "local",
    sourceSchemaRevision: "synthetic-only",
    owners: Array.from({ length: 8 }, (_, i) => ({
      ownerId: id(i + 1),
      hotelId: id(i + 11),
      userOrdinal: i + 1,
      hotelOrdinal: i + 1,
      userSha256: hash,
      hotelSha256: hash,
    })),
  },
};
const command = {
  contractVersion: "legacy-owner-internal-setup.v1",
  commandId: id(99),
  environment: "local",
  issuedAt: "2026-09-15T01:01:00.000Z",
  expiresAt: "2026-09-15T01:15:00.000Z",
  targetDatabaseSha256: hash,
  sourceRunId: context.source.sourceRunId,
  sourceLedgerSha256: hash,
  owners: [
    {
      ...context.source.owners[0]!,
      email: "Owner@example.invalid",
      name: null,
      status: "pending",
      expectedTarget: "absent",
      targetBeforeSha256: hash,
      currentEvidenceSha256: hash,
      observedAt: "2026-09-15T01:00:00.000Z",
    },
  ],
};
const commandPayload = canonicalizeJson(command);
const envelope = {
  contractVersion: command.contractVersion,
  commandId: command.commandId,
  environment: command.environment,
  issuedAt: command.issuedAt,
  expiresAt: command.expiresAt,
  commandSha256: createHash("sha256")
    .update("vayada:legacy-owner-internal-setup:v1\0command\0")
    .update(commandPayload)
    .digest("hex"),
  migrationApprovalRecordId: id(100),
  securityApprovalRecordId: id(101),
  signingKeyId: "fixture",
};
function request(overrides: Record<string, unknown> = {}) {
  const envelopePayload = canonicalizeJson({ ...envelope, ...overrides });
  return {
    commandPayload,
    envelopePayload,
    detachedSignature: sign(
      null,
      Buffer.from(`vayada:legacy-owner-internal-setup:v1\0envelope\0${envelopePayload}`),
      keys.privateKey,
    ).toString("base64url"),
    verificationKeys: new Map([["fixture", keys.publicKey]]),
  };
}
const reject = (input: ReturnType<typeof request>) =>
  expect(() => verifyLegacyOwnerSetupRequest(input, context, now)).toThrow(
    /^LEGACY_OWNER_SETUP_REQUEST_INVALID$/,
  );

describe("signed owner setup request composition", () => {
  it("binds the exact command to a real synthetic signature without granting execution", () => {
    expect(verifyLegacyOwnerSetupRequest(request(), context, now)).toEqual({
      outcome: "signed_command_matches_requires_current_evidence",
      executable: false,
      command,
      commandSha256: envelope.commandSha256,
      envelope,
    });
  });
  it.each([
    ["commandId", id(98)],
    ["environment", "production"],
    ["issuedAt", "2026-09-15T01:02:00.000Z"],
    ["expiresAt", "2026-09-15T01:14:00.000Z"],
    ["commandSha256", hash],
    ["contractVersion", "legacy-pms-owner-evidence.v1"],
  ])("rejects a valid signature over mismatched %s", (field, value) =>
    reject(request({ [field!]: value })),
  );
  it.each(["email", "name", "targetBeforeSha256", "currentEvidenceSha256"])(
    "rejects changed command %s with unchanged approval",
    (field) => {
      const changed = structuredClone(command);
      Object.assign(changed.owners[0]!, {
        [field]: field.endsWith("Sha256") ? "b".repeat(64) : "other@example.invalid",
      });
      reject({ ...request(), commandPayload: canonicalizeJson(changed) });
    },
  );
  it("rejects added owners without silently accepting a new subset", () => {
    const changed = structuredClone(command);
    changed.owners.push({
      ...changed.owners[0]!,
      ...context.source.owners[1]!,
      email: "second@example.invalid",
    });
    reject({ ...request(), commandPayload: canonicalizeJson(changed) });
  });
  it("rejects malformed input and bad signatures without contact/error leakage", () => {
    reject({ ...request(), commandPayload: "invalid-sensitive-fixture" });
    reject({ ...request(), envelopePayload: "invalid-sensitive-fixture" });
    reject({ ...request(), detachedSignature: "invalid-sensitive-fixture" });
    reject({ ...request(), verificationKeys: new Map() });
  });
  it("does not let a fresh envelope renew an expired command", () => {
    const input = request({
      issuedAt: "2026-09-15T01:16:00.000Z",
      expiresAt: "2026-09-15T01:20:00.000Z",
    });
    expect(() =>
      verifyLegacyOwnerSetupRequest(input, context, new Date("2026-09-15T01:17:00.000Z")),
    ).toThrow(/^LEGACY_OWNER_SETUP_REQUEST_INVALID$/);
  });
});
