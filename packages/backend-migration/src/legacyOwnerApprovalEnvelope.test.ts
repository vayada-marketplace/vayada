import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import {
  hashLegacyOwnerApprovalEvidence,
  LEGACY_OWNER_APPROVAL_VERSION,
  verifyLegacyOwnerApprovalEnvelope,
  type LegacyOwnerApprovalEnvelope,
} from "./legacyOwnerApprovalEnvelope.js";
import type { LegacyOwnerEvidenceRequest } from "./legacyOwnerEvidenceSnapshot.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const keys = generateKeyPairSync("ed25519");
const domain = "vayada:legacy-pms-owner-evidence:v1\0envelope\0";
function fixture() {
  const evidence: LegacyOwnerEvidenceRequest = {
    source: {
      sourceRunId: `vay1351-${"a".repeat(24)}`,
      sourceEnvironment: "preprod",
      sourceSchemaRevision: "b".repeat(40),
      sourceEvidenceSha256: "c".repeat(64),
      legacyHotelId: uuid(10),
      ownerUserId: uuid(1),
      hotelRowOrdinal: 1,
      userRowOrdinal: 1,
    },
    target: Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(([kind, table], i) => ({
      kind,
      table,
      id: uuid(i + 1),
      rowStateSha256: "d".repeat(64),
    })) as LegacyOwnershipFingerprint[],
    identity: {
      userId: uuid(1),
      organizationId: uuid(3),
      externalIdentityId: uuid(11),
      externalIdentitySha256: "e".repeat(64),
      workosUserId: "user_fixture",
      workosOrgId: "org_fixture",
    },
  };
  const envelope: LegacyOwnerApprovalEnvelope = {
    contractVersion: LEGACY_OWNER_APPROVAL_VERSION,
    commandId: uuid(12),
    environment: "preprod",
    issuedAt: "2026-09-14T01:00:00.000Z",
    expiresAt: "2026-09-14T02:00:00.000Z",
    evidenceSha256: hashLegacyOwnerApprovalEvidence(evidence),
    migrationApprovalRecordId: uuid(13),
    securityApprovalRecordId: uuid(14),
    signingKeyId: "synthetic-only",
  };
  const signed = (value: unknown = envelope) => {
    const canonicalPayload = canonicalizeJson(value);
    return {
      canonicalPayload,
      detachedSignature: sign(
        null,
        Buffer.from(domain + canonicalPayload),
        keys.privateKey,
      ).toString("base64url"),
    };
  };
  const input = () => ({
    ...signed(),
    verificationKeys: new Map([[envelope.signingKeyId, keys.publicKey]]),
    environment: "preprod" as const,
    evidence,
    now: new Date("2026-09-14T01:30:00.000Z"),
  });
  return { evidence, envelope, signed, input };
}
describe("legacy owner evidence envelope, synthetic signing keys only", () => {
  it("authenticates exact evidence without claiming approval or access", () => {
    const f = fixture();
    expect(verifyLegacyOwnerApprovalEnvelope(f.input())).toEqual({
      outcome: "signature_matches_requires_registry",
      envelope: f.envelope,
    });
  });
  it.each(["source", "target", "identity"])("rejects changed %s evidence", (field) => {
    const f = fixture();
    const input = f.input();
    if (field === "source") input.evidence.source.ownerUserId = uuid(99);
    if (field === "target") input.evidence.target[0]!.rowStateSha256 = "f".repeat(64);
    if (field === "identity") input.evidence.identity.workosUserId = "user_other";
    expect(() => verifyLegacyOwnerApprovalEnvelope(input)).toThrow("evidence_mismatch");
  });
  it.each(["commandId", "migrationApprovalRecordId", "securityApprovalRecordId"] as const)(
    "rejects unsigned change to %s",
    (field) => {
      const f = fixture();
      const input = f.input();
      input.canonicalPayload = canonicalizeJson({ ...f.envelope, [field]: uuid(99) });
      expect(() => verifyLegacyOwnerApprovalEnvelope(input)).toThrow("invalid_signature");
    },
  );
  it.each([
    ["contractVersion", "channex-property-adoption.v1", "wrong_contract"],
    ["environment", "production", "wrong_environment"],
    ["issuedAt", "2026-09-14T01:31:00.000Z", "invalid_time_window"],
    ["expiresAt", "2026-09-14T01:30:00.000Z", "invalid_time_window"],
    ["expiresAt", "2026-09-14T00:00:00.000Z", "invalid_time_window"],
    ["issuedAt", "2026-09-14T01:00:00Z", "invalid_time_window"],
    ["issuedAt", "-000001-09-14T01:00:00.000Z", "invalid_time_window"],
    ["securityApprovalRecordId", uuid(13), "invalid_authority_records"],
    ["commandId", "not-uuid", "invalid_authority_records"],
  ])("rejects signed invalid %s=%s", (field, value, reason) => {
    const f = fixture();
    expect(() =>
      verifyLegacyOwnerApprovalEnvelope({
        ...f.input(),
        ...f.signed({ ...f.envelope, [field!]: value }),
      }),
    ).toThrow(reason);
  });
  it.each(["duplicate", "whitespace", "extra", "missing", "malformed"])(
    "rejects %s JSON",
    (change) => {
      const f = fixture();
      const input = f.input();
      if (change === "duplicate")
        input.canonicalPayload = input.canonicalPayload.replace(
          "{",
          `{"commandId":"${f.envelope.commandId}",`,
        );
      if (change === "whitespace") input.canonicalPayload += "\n";
      if (change === "extra")
        Object.assign(input, f.signed({ ...f.envelope, grantAllAccess: true }));
      if (change === "missing") {
        const { signingKeyId: _key, ...rest } = f.envelope;
        Object.assign(input, f.signed(rest));
      }
      if (change === "malformed") input.canonicalPayload = "{";
      expect(() => verifyLegacyOwnerApprovalEnvelope(input)).toThrow();
    },
  );
  it.each(["wrong key", "private key", "unknown key", "padding", "wrong domain", "invalid clock"])(
    "rejects %s",
    (change) => {
      const f = fixture();
      const input = f.input();
      if (change === "wrong key")
        input.verificationKeys.set(
          f.envelope.signingKeyId,
          generateKeyPairSync("ed25519").publicKey,
        );
      if (change === "private key")
        input.verificationKeys.set(f.envelope.signingKeyId, keys.privateKey);
      if (change === "unknown key") input.verificationKeys.clear();
      if (change === "padding") input.detachedSignature += "=";
      if (change === "wrong domain")
        input.detachedSignature = sign(
          null,
          Buffer.from(input.canonicalPayload),
          keys.privateKey,
        ).toString("base64url");
      if (change === "invalid clock") input.now = new Date(NaN);
      expect(() => verifyLegacyOwnerApprovalEnvelope(input)).toThrow();
    },
  );
});
