import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { verifyLegacyOwnerApprovalEnvelope } from "./legacyOwnerApprovalEnvelope.js";
import {
  LEGACY_OWNER_SETUP_VERSION,
  verifyLegacyOwnerSetupSignature,
  type LegacyOwnerSetupEnvelope,
} from "./legacyOwnerSetupSignature.js";

const keys = generateKeyPairSync("ed25519"); // Synthetic test keys; never production approval.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const domain = "vayada:legacy-owner-internal-setup:v1\0envelope\0";
function fixture() {
  const envelope: LegacyOwnerSetupEnvelope = {
    contractVersion: LEGACY_OWNER_SETUP_VERSION,
    commandId: uuid(1),
    environment: "preprod",
    issuedAt: "2026-09-15T01:00:00.000Z",
    expiresAt: "2026-09-15T01:15:00.000Z",
    commandSha256: "a".repeat(64),
    migrationApprovalRecordId: uuid(2),
    securityApprovalRecordId: uuid(3),
    signingKeyId: "synthetic-only",
  };
  const signed = (value: unknown = envelope, prefix = domain) => {
    const canonicalPayload = canonicalizeJson(value);
    return {
      canonicalPayload,
      detachedSignature: sign(
        null,
        Buffer.from(prefix + canonicalPayload),
        keys.privateKey,
      ).toString("base64url"),
    };
  };
  return {
    envelope,
    signed,
    input: {
      ...signed(),
      expectedCommandSha256: envelope.commandSha256,
      environment: "preprod" as const,
      now: new Date("2026-09-15T01:05:00.000Z"),
      verificationKeys: new Map([[envelope.signingKeyId, keys.publicKey]]),
    },
  };
}
describe("separate internal owner setup signature", () => {
  it("verifies the exact signature without approving or executing the command", () => {
    const f = fixture();
    expect(verifyLegacyOwnerSetupSignature(f.input)).toEqual({
      outcome: "signature_matches_requires_registry",
      executable: false,
      envelope: f.envelope,
    });
  });
  it.each([
    ["contractVersion", "legacy-pms-owner-evidence.v1"],
    ["environment", "production"],
    ["commandId", "invalid"],
    ["securityApprovalRecordId", uuid(2)],
    ["issuedAt", "2026-09-15T01:06:00.000Z"],
    ["expiresAt", "2026-09-15T01:05:00.000Z"],
    ["expiresAt", "2026-09-15T00:59:00.000Z"],
    ["issuedAt", "2026-09-15T01:00:00Z"],
    ["commandSha256", "b".repeat(64)],
    ["commandSha256", "invalid"],
    ["signingKeyId", "unknown"],
    ["signingKeyId", "bad key"],
  ])("rejects signed invalid %s", (field, value) => {
    const f = fixture();
    expect(() =>
      verifyLegacyOwnerSetupSignature({
        ...f.input,
        ...f.signed({ ...f.envelope, [field!]: value }),
      }),
    ).toThrow(/^LEGACY_OWNER_SETUP_SIGNATURE_INVALID$/);
  });
  it.each(["commandId", "migrationApprovalRecordId", "securityApprovalRecordId"])(
    "rejects an unsigned change to %s",
    (field) => {
      const f = fixture();
      expect(() =>
        verifyLegacyOwnerSetupSignature({
          ...f.input,
          canonicalPayload: canonicalizeJson({ ...f.envelope, [field]: uuid(99) }),
        }),
      ).toThrow();
    },
  );
  it.each([
    "wrong domain",
    "bare signature",
    "padding",
    "private key",
    "wrong key",
    "bad clock",
    "bad expected hash",
  ])("rejects %s", (change) => {
    const f = fixture();
    if (change === "wrong domain")
      Object.assign(
        f.input,
        f.signed(f.envelope, "vayada:legacy-pms-owner-evidence:v1\0envelope\0"),
      );
    if (change === "bare signature") Object.assign(f.input, f.signed(f.envelope, ""));
    if (change === "padding") f.input.detachedSignature += "=";
    if (change === "private key")
      f.input.verificationKeys.set(f.envelope.signingKeyId, keys.privateKey);
    if (change === "wrong key")
      f.input.verificationKeys.set(
        f.envelope.signingKeyId,
        generateKeyPairSync("ed25519").publicKey,
      );
    if (change === "bad clock") f.input.now = new Date(NaN);
    if (change === "bad expected hash") f.input.expectedCommandSha256 = "invalid";
    expect(() => verifyLegacyOwnerSetupSignature(f.input)).toThrow(
      /^LEGACY_OWNER_SETUP_SIGNATURE_INVALID$/,
    );
  });
  it.each(["duplicate", "whitespace", "extra", "missing", "malformed"])(
    "rejects %s JSON",
    (change) => {
      const f = fixture();
      if (change === "duplicate")
        f.input.canonicalPayload = f.input.canonicalPayload.replace(
          "{",
          `{"commandId":"${f.envelope.commandId}",`,
        );
      if (change === "whitespace") f.input.canonicalPayload += "\n";
      if (change === "extra")
        Object.assign(f.input, f.signed({ ...f.envelope, grantAllAccess: true }));
      if (change === "missing") {
        const { signingKeyId: _key, ...rest } = f.envelope;
        Object.assign(f.input, f.signed(rest));
      }
      if (change === "malformed") f.input.canonicalPayload = "{";
      expect(() => verifyLegacyOwnerSetupSignature(f.input)).toThrow();
    },
  );
  it("does not let the unchanged ownership verifier accept a setup signature", () => {
    const f = fixture();
    // Old schema uses evidenceSha256; even adapting the field cannot cross domains/contracts.
    const { commandSha256, ...rest } = f.envelope;
    const input = {
      ...f.input,
      ...f.signed({ ...rest, evidenceSha256: commandSha256 }),
      get evidence(): never {
        throw new Error("Setup contract must be rejected before reading ownership evidence");
      },
    };
    expect(() => verifyLegacyOwnerApprovalEnvelope(input)).toThrow("wrong_contract");
  });
});
